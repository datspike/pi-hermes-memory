import { MemoryStore } from '../../src/store/memory-store.js';
import type { MemoryConfig } from '../../src/types.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { indexSession, upsertSessionFileMetadata, indexChangedSessionsBounded, SESSION_BACKFILL_SCAN_CURSOR_KEY, SESSION_BACKFILL_DEFERRED_KEY } from '../../src/store/session-indexer.js';
import { searchSessionEvidence } from '../../src/store/session-search.js';
import { addMemory, reconcileMarkdownFailureScopes, searchMemories } from '../../src/store/sqlite-memory-store.js';
import { syncMarkdownMemoriesToSqlite } from '../../src/handlers/sync-markdown-memories.js';

/** Exercise canonical query evaluation, resumable discovery, and authoritative failure sync. */
describe('canonical search and bounded startup sync', () => {
  let root: string;
  let sessions: string;
  let manager: DatabaseManager;
  const timestamp = '2026-10-02T00:00:00Z';
  const write = (id: string, content: string) => {
    const file = path.join(sessions, `${id}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session', id, cwd: '/project-a', timestamp })}\n${JSON.stringify({ type: 'message', id: 'entry', timestamp, message: { role: 'user', content } })}\n`);
    return file;
  };
  const indexed = (id: string, content: string) => {
    const file = write(id, content);
    indexSession(manager, { id, project: 'project-a', cwd: '/project-a', startedAt: timestamp, endedAt: null, messages: [{ id: 'entry', role: 'user', content, timestamp }] });
    upsertSessionFileMetadata(manager, file, id);
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-sync-progress-'));
    sessions = path.join(root, 'sessions'); fs.mkdirSync(sessions);
    manager = new DatabaseManager(path.join(root, 'memory'));
  });
  afterEach(() => { manager.close(); fs.rmSync(root, { recursive: true, force: true }); });

  for (const [query, original, rejected, accepted] of [
    ['needle NOT forbidden', 'needle', 'needle forbidden', 'needle allowed'],
    ['needle AND second', 'needle second', 'needle unrelated', 'needle second changed'],
    ['NEAR(needle second, 5)', 'needle second', `needle ${'unrelated '.repeat(20)}second`, 'needle second'],
    ['"needle phrase"', 'needle phrase', 'needle interrupted phrase', 'new needle phrase tail'],
  ]) {
    it(`structured canonical verification preserves ${query}`, () => {
      indexed('operators', original);
      write('operators', rejected);
      assert.equal(searchSessionEvidence(manager, query, { sessionsDir: sessions }).results.length, 0);
      write('operators', accepted);
      const results = searchSessionEvidence(manager, query, { sessionsDir: sessions }).results;
      assert.equal(results.length, 1);
      assert.equal(results[0].anchor, 'pi://session/operators#entry=entry');
    });
  }
  it('structured OR uses changed canonical content, not stale terms or snippets', () => {
    indexed('operators', 'needle'); write('operators', 'alternate');
    assert.equal(searchSessionEvidence(manager, 'needle OR alternate', { sessionsDir: sessions }).results[0].snippet, 'alternate');
  });
  it('keeps natural-language OR broadening and short literal fallback without weakening explicit AND', () => {
    indexed('ordinary', 'needle 短文');
    assert.equal(searchSessionEvidence(manager, 'needle missing', { sessionsDir: sessions }).results.length, 1);
    assert.equal(searchSessionEvidence(manager, 'needle AND missing', { sessionsDir: sessions }).results.length, 0);
    assert.equal(searchSessionEvidence(manager, '短文', { sessionsDir: sessions }).results.length, 1);
  });
  it('does not repeat a full canonical scan when a query match is excluded as tool output', () => {
    indexed('private-tool', 'needle');
    const file = path.join(sessions, 'private-tool.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session', id: 'private-tool', cwd: '/project-a', timestamp })}\n${JSON.stringify({ type: 'message', id: 'entry', timestamp, message: { role: 'toolResult', toolName: 'probe', toolCallId: 'call', content: 'needle' } })}\n`);
    const open = fs.openSync; let reads = 0;
    try {
      (fs as any).openSync = (source: any, ...args: any[]) => { if (source === file) reads++; return (open as any)(source, ...args); };
      assert.equal(searchSessionEvidence(manager, 'needle', { sessionsDir: sessions }).results.length, 0);
      assert.equal(reads, 1);
    } finally { fs.openSync = open; }
  });

  it('advances discovery after consecutive deadline overruns, including after reopen', async () => {
    for (const id of ['a', 'b', 'c']) write(id, 'progress');
    const realNow = Date.now; let now = realNow(); const cursors: string[] = [];
    try {
      Date.now = () => now;
      for (let run = 0; run < 3; run++) {
        const result = await indexChangedSessionsBounded(manager, sessions, { maxDurationMs: 50, yieldFn: async () => { now += 60; } });
        assert.equal(result.partial, true);
        const cursor = manager.getDb().prepare('SELECT value FROM extension_metadata WHERE key = ?').get(SESSION_BACKFILL_SCAN_CURSOR_KEY) as { value: string };
        cursors.push(path.basename(cursor.value));
        manager.close(); manager = new DatabaseManager(path.join(root, 'memory'));
      }
      assert.deepEqual(cursors, ['a.jsonl', 'b.jsonl', 'c.jsonl']);
    } finally { Date.now = realNow; }
  });
  it('reserves indexing time and reaches every file under repeated incomplete discovery', async () => {
    for (const id of ['a', 'b', 'c', 'd']) write(id, 'progress');
    const realNow = Date.now; let now = realNow();
    try {
      Date.now = () => now;
      for (let run = 0; run < 12 && manager.getStats().sessions < 4; run++) {
        await indexChangedSessionsBounded(manager, sessions, { maxDurationMs: 100, yieldFn: async () => { now += 20; } });
      }
      assert.equal(manager.getStats().sessions, 4);
      assert.equal(manager.getStats().messages, 4);
    } finally { Date.now = realNow; }
  });
  it('does not remove existing owners when cursor discovery only enumerates a suffix', async () => {
    indexed('a', 'preserved'); write('b', 'progress'); write('c', 'progress');
    manager.getDb().prepare('INSERT INTO extension_metadata(key, value) VALUES (?, ?)').run(SESSION_BACKFILL_SCAN_CURSOR_KEY, path.join(sessions, 'a.jsonl'));
    await indexChangedSessionsBounded(manager, sessions, { maxDurationMs: 1000 });
    assert.deepEqual(manager.getDb().prepare('SELECT id FROM sessions ORDER BY id').all(), [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    assert.equal((manager.getDb().prepare('SELECT COUNT(*) AS n FROM session_files').get() as { n: number }).n, 3);
  });
  it('scoped bounded cleanup never removes a foreign project owner', async () => {
    const file = write('foreign', 'preserved');
    indexed('foreign', 'preserved');
    fs.mkdirSync(path.join(sessions, 'project-a'));
    const own = path.join(sessions, 'project-a', 'own.jsonl');
    fs.renameSync(write('own', 'progress'), own);
    const deferred = JSON.stringify({ [file]: { size: fs.statSync(file).size, mtimeMs: Math.trunc(fs.statSync(file).mtimeMs) } });
    manager.getDb().prepare('INSERT INTO extension_metadata(key, value) VALUES (?, ?)').run(SESSION_BACKFILL_DEFERRED_KEY, deferred);
    await indexChangedSessionsBounded(manager, sessions, { projectDir: 'project-a', maxDurationMs: 1000 });
    assert.ok(manager.getDb().prepare("SELECT id FROM sessions WHERE id='foreign'").get());
    assert.ok(manager.getDb().prepare('SELECT path FROM session_files WHERE path=?').get(file));
    assert.equal((manager.getDb().prepare('SELECT value FROM extension_metadata WHERE key=?').get(SESSION_BACKFILL_DEFERRED_KEY) as { value: string }).value, deferred);
  });
  it('rejects a scope outside the sessions root without deleting owners', async () => {
    indexed('foreign', 'preserved');
    const outside = path.join(root, 'outside.jsonl');
    fs.renameSync(write('outside', 'preserved'), outside);
    const result = await indexChangedSessionsBounded(manager, sessions, { projectDir: '..', maxDurationMs: 1000 });
    assert.ok(manager.getDb().prepare("SELECT id FROM sessions WHERE id='foreign'").get());
    assert.equal(result.partial, true);
    assert.equal(result.errors.length, 1);
  });
  it('restarts discovery when the cursor owner disappears and cleans only missing owners', async () => {
    indexed('a', 'preserved'); indexed('z', 'removed');
    fs.unlinkSync(path.join(sessions, 'z.jsonl'));
    manager.getDb().prepare('INSERT INTO extension_metadata(key, value) VALUES (?, ?)').run(SESSION_BACKFILL_SCAN_CURSOR_KEY, path.join(sessions, 'z.jsonl'));
    await indexChangedSessionsBounded(manager, sessions, { maxDurationMs: 1000 });
    assert.deepEqual(manager.getDb().prepare('SELECT id FROM sessions ORDER BY id').all(), [{ id: 'a' }]);
    assert.equal(manager.getDb().prepare('SELECT value FROM extension_metadata WHERE key=?').get(SESSION_BACKFILL_SCAN_CURSOR_KEY) == null, true);
  });

  for (const mode of ['startup', 'explicit'] as const) {
    it(`${mode} sync excludes malformed project metadata and repairs stale global mirror rows`, async () => {
      const bad = 'BAD_ONLY <!-- created=2026-10-02, last=2026-10-02, project64=@@ -->';
      const valid = `VALID_ONLY <!-- created=2026-10-02, last=2026-10-02, project64=${Buffer.from('project-a').toString('base64url')} -->`;
      const content = `${bad}\n\n§\n\n${valid}`;
      fs.writeFileSync(path.join(root, 'failures.md'), content);
      addMemory(manager, bad, 'failure', null);
      const result = await syncMarkdownMemoriesToSqlite(manager, root, 'projects-memory', root, mode === 'startup' ? { onlyProjects: ['project-a'] } : { force: true });
      assert.equal(result.warnings.length, 0);
      assert.equal(searchMemories(manager, 'BAD_ONLY', { target: 'failure', project: null }).length, 0);
      assert.equal(searchMemories(manager, 'VALID_ONLY', { target: 'failure', project: 'project-a' }).length, 1);
      assert.equal(searchMemories(manager, 'VALID_ONLY', { target: 'failure', project: null }).length, 0);
      assert.equal(fs.readFileSync(path.join(root, 'failures.md'), 'utf8'), content);
    });
  }
  it('does not downgrade empty, non-canonical, or invalid UTF-8 project metadata to a scope', () => {
    const entries = ['@@', '', '_', 'wK8', 'YQF'].map(project => `UNKNOWN_ONLY <!-- created=2026-10-02, last=2026-10-02, project64=${project} -->`);
    reconcileMarkdownFailureScopes(manager, entries);
    assert.equal((manager.getDb().prepare("SELECT COUNT(*) AS n FROM memories WHERE target='failure'").get() as { n: number }).n, 0);
  });
  for (const suffix of ['last=2026-10-02, project64 =@@', 'last=2026-10-02 project64=@@']) {
    it(`does not globalize malformed field placement: ${suffix}`, async () => {
      const bad = `UNKNOWN_ONLY <!-- created=2026-10-02, ${suffix} -->`;
      fs.writeFileSync(path.join(root, 'failures.md'), bad);
      reconcileMarkdownFailureScopes(manager, [bad]);
      assert.equal(searchMemories(manager, 'UNKNOWN_ONLY', { target: 'failure', project: null }).length, 0);
      const store = new MemoryStore({ memoryDir: root, memoryMode: 'legacy-inject', memoryCharLimit: 100000, userCharLimit: 100000, failureInjectionEnabled: true } as MemoryConfig);
      await store.loadFromDisk();
      assert.equal(store.getFailureEntries(30, null).length, 0);
      assert.equal(store.getRawEntriesForSync('failure').includes(bad), true);
    });
  }
});
