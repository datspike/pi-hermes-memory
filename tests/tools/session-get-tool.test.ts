import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { indexAllSessions, indexSession, upsertSessionFileMetadata } from '../../src/store/session-indexer.js';
import { parseSessionFile, SESSION_SEARCH_MAX_SCAN_BYTES } from '../../src/store/session-parser.js';
import { searchSessionEvidence } from '../../src/store/session-search.js';
import { registerSessionGetTool } from '../../src/tools/session-get-tool.js';

let root = '';
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = ''; });

function capture(db: DatabaseManager, sessionsDir?: string): any {
  let definition: any;
  registerSessionGetTool({ registerTool: (value: any) => { definition = value; } } as any, db, { sessionsDir });
  return definition;
}

function writeSession(file: string, id: string, entries: Array<Record<string, unknown>>, cwd = '/work/vault'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: 'session', id, timestamp: '2026-08-09T00:00:00.000Z', cwd },
    ...entries,
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

describe('session_get', () => {
  it('round-trips an exact structured search anchor and returns full metadata', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-get-'));
    const db = new DatabaseManager(root);
    try {
      const file = path.join(root, 'session.jsonl');
      writeSession(file, 'full-session-id', [
        { type: 'message', id: 'first', parentId: null, timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'user', content: 'first' } },
        { type: 'message', id: 'target', parentId: 'first', timestamp: '2026-08-09T00:02:00.000Z', message: { role: 'assistant', toolCallId: 'get-tool-call-id', content: 'needle target' } },
        { type: 'message', id: 'last', parentId: 'target', timestamp: '2026-08-09T00:03:00.000Z', message: { role: 'user', content: 'last' } },
      ]);
      const parsed = parseSessionFile(file)!;
      indexSession(db, parsed);
      upsertSessionFileMetadata(db, file, parsed.id);
      const tool = capture(db);
      const result = await tool.execute('call', { session_id: 'full-session-id', entry_id: 'target', before: 1, after: 1 });
      assert.equal(result.details.success, true);
      assert.equal(result.details.entry.entry_id, 'target');
      assert.equal(result.details.entry.tool_call_id, 'get-tool-call-id');
      assert.equal(result.details.entry.anchor, 'pi://session/full-session-id#entry=target');
      assert.deepEqual(result.details.before.map((entry: any) => entry.entry_id), ['first']);
      assert.deepEqual(result.details.after.map((entry: any) => entry.entry_id), ['last']);
      assert.equal(result.details.session.cwd, '/work/vault');
      assert.equal(result.details.session.name, null);
    } finally { db.close(); }
  });

  it('skips service events between a message and the session root when resolving context', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-get-'));
    const db = new DatabaseManager(root);
    try {
      const file = path.join(root, 'service-interleaved.jsonl');
      writeSession(file, 'service-interleaved-session', [
        { type: 'session_info', id: 'session-info', parentId: null, timestamp: '2026-08-09T00:00:30.000Z' },
        { type: 'custom', id: 'service-event', parentId: 'session-info', timestamp: '2026-08-09T00:00:45.000Z' },
        { type: 'message', id: 'first', parentId: null, timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'user', content: 'first' } },
        { type: 'message', id: 'target', parentId: 'first', timestamp: '2026-08-09T00:02:00.000Z', message: { role: 'assistant', content: 'needle target' } },
        { type: 'message', id: 'last', parentId: 'target', timestamp: '2026-08-09T00:03:00.000Z', message: { role: 'user', content: 'last' } },
      ]);
      const parsed = parseSessionFile(file)!;
      indexSession(db, parsed);
      upsertSessionFileMetadata(db, file, parsed.id);
      const result = await capture(db).execute('service-interleaved', { session_id: 'service-interleaved-session', entry_id: 'target', before: 1, after: 1 });
      assert.equal(result.details.success, true);
      assert.deepEqual(result.details.before.map((entry: any) => entry.entry_id), ['first']);
      assert.deepEqual(result.details.after.map((entry: any) => entry.entry_id), ['last']);
    } finally { db.close(); }
  });

  it('uses a valid older owner when the newest linked path is missing', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-get-'));
    const db = new DatabaseManager(root);
    try {
      const older = path.join(root, 'older.jsonl');
      const newer = path.join(root, 'newer.jsonl');
      writeSession(older, 'multi-path', [{ type: 'message', id: 'older-entry', timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'user', content: 'older' } }]);
      writeSession(newer, 'multi-path', [{ type: 'message', id: 'newer-entry', timestamp: '2026-08-09T00:02:00.000Z', message: { role: 'user', content: 'newer' } }]);
      const parsed = parseSessionFile(older)!;
      indexSession(db, parsed);
      upsertSessionFileMetadata(db, older, parsed.id, undefined, new Date('2026-08-09T00:00:00Z'));
      upsertSessionFileMetadata(db, newer, parsed.id, undefined, new Date('2026-08-09T00:01:00Z'));
      fs.unlinkSync(newer);
      const result = await capture(db).execute('call', { session_id: 'multi-path', entry_id: 'older-entry' });
      assert.equal(result.details.success, true);
      assert.equal(result.details.entry.entry_id, 'older-entry');
      assert.equal((db.getDb().prepare('SELECT COUNT(*) AS count FROM session_files WHERE session_id = ?').get('multi-path') as any).count, 1);
      fs.unlinkSync(older);
      const unavailable = await capture(db).execute('missing-all', { session_id: 'multi-path', entry_id: 'older-entry' });
      assert.equal(unavailable.details.error, 'transcript_unavailable');
      assert.equal((db.getDb().prepare('SELECT COUNT(*) AS count FROM sessions WHERE id = ?').get('multi-path') as any).count, 0);
      assert.equal((db.getDb().prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get('multi-path') as any).count, 0);
    } finally { db.close(); }
  });

  it('opens an exact existing transcript even when startup indexing did not register its owner', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-get-unregistered-'));
    const db = new DatabaseManager(path.join(root, 'db'));
    try {
      const file = path.join(root, 'unregistered-session.jsonl');
      writeSession(file, 'unregistered-session', [{ type: 'message', id: 'unregistered-entry', timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'user', content: 'recoverable exact transcript' } }]);
      const result = await capture(db, root).execute('unregistered', { session_id: 'unregistered-session', entry_id: 'unregistered-entry' });
      assert.equal(result.details.success, true);
      assert.equal(result.details.entry.content, 'recoverable exact transcript');
    } finally { db.close(); }
  });

  it('treats contained aliases of one unregistered file as a single owner', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-get-contained-alias-'));
    const sessionsDir = path.join(root, 'sessions');
    const source = path.join(sessionsDir, 'project', 'source.jsonl');
    writeSession(source, 'alias-session', [{ type: 'message', id: 'target', timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'user', content: 'one physical owner' } }]);
    fs.symlinkSync(source, path.join(sessionsDir, 'file-alias.jsonl'));
    fs.symlinkSync(path.dirname(source), path.join(sessionsDir, 'directory-alias'), 'dir');
    const rootAlias = path.join(root, 'root-alias');
    fs.symlinkSync(sessionsDir, rootAlias, 'dir');
    const db = new DatabaseManager(path.join(root, 'db'));
    try {
      const result = await capture(db, rootAlias).execute('aliased-source', { session_id: 'alias-session', entry_id: 'target' });
      assert.equal(result.details.success, true);
      assert.equal(result.details.entry.content, 'one physical owner');
    } finally { db.close(); }
  });

  for (const shape of ['traversal', 'leaf-symlink', 'directory-symlink'] as const) {
    it(`ignores external metadata for an unregistered ${shape} session identity`, async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-get-external-budget-'));
      const sessionsDir = path.join(root, 'sessions');
      const sessionId = shape === 'traversal' ? '../victim' : shape === 'directory-symlink' ? 'linked/victim' : 'victim';
      writeSession(path.join(sessionsDir, 'safe.jsonl'), sessionId, [{ type: 'message', id: 'target', timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'user', content: 'exact contained source' } }]);
      const external = path.join(root, 'victim.jsonl');
      const fd = fs.openSync(external, 'w');
      try { fs.ftruncateSync(fd, SESSION_SEARCH_MAX_SCAN_BYTES + 1); } finally { fs.closeSync(fd); }
      if (shape === 'leaf-symlink') fs.symlinkSync(external, path.join(sessionsDir, 'victim.jsonl'));
      if (shape === 'directory-symlink') fs.symlinkSync(root, path.join(sessionsDir, 'linked'), 'dir');
      const db = new DatabaseManager(path.join(root, 'db'));
      const originalStat = fs.statSync;
      const unsafeStats: string[] = [];
      const preferred = path.join(sessionsDir, `${sessionId}.jsonl`);
      try {
        fs.statSync = ((file: any, options?: any) => {
          if (file === external || file === preferred) unsafeStats.push(file);
          return originalStat(file, options);
        }) as typeof fs.statSync;
        const result = await capture(db, sessionsDir).execute('contained-source', { session_id: sessionId, entry_id: 'target', before: 0, after: 0 });
        assert.equal(result.details.success, true);
        assert.equal(result.details.entry.content, 'exact contained source');
        assert.deepEqual(unsafeStats, []);
      } finally { fs.statSync = originalStat; db.close(); }
    });
  }

  it('retains the fallback read limit for a contained oversized file', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-get-contained-budget-'));
    const sessionsDir = path.join(root, 'sessions');
    fs.mkdirSync(sessionsDir);
    const fd = fs.openSync(path.join(sessionsDir, 'large-session.jsonl'), 'w');
    try { fs.ftruncateSync(fd, SESSION_SEARCH_MAX_SCAN_BYTES + 1); } finally { fs.closeSync(fd); }
    const db = new DatabaseManager(path.join(root, 'db'));
    try {
      const result = await capture(db, sessionsDir).execute('contained-limit', { session_id: 'large-session', entry_id: 'target' });
      assert.deepEqual(result.details, { success: false, error: 'transcript_read_limit' });
      assert.equal(result.isError, true);
    } finally { db.close(); }
  });

  it('reports a changed unregistered transcript instead of a missing file', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-get-changed-unregistered-'));
    const db = new DatabaseManager(path.join(root, 'db'));
    const originalFstat = fs.fstatSync;
    let fileChecks = 0;
    try {
      writeSession(path.join(root, 'changed.jsonl'), 'changed-session', [{ type: 'message', id: 'target', timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'user', content: 'changed source' } }]);
      fs.fstatSync = ((fd: any, options?: any) => {
        const stat = originalFstat(fd, options);
        if (options?.bigint && stat.isFile() && ++fileChecks === 2) return { ...stat, size: (stat.size as bigint) + 1n };
        return stat;
      }) as typeof fs.fstatSync;
      const result = await capture(db, root).execute('changed', { session_id: 'changed-session', entry_id: 'target' });
      assert.equal(fileChecks, 2);
      assert.deepEqual(result.details, { success: false, error: 'transcript_changed' });
      assert.equal(result.isError, true);
    } finally { fs.fstatSync = originalFstat; db.close(); }
  });

  it('reports bounded unregistered parser overflow as a read limit', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-get-unregistered-overflow-'));
    const db = new DatabaseManager(path.join(root, 'db'));
    const originalFstat = fs.fstatSync;
    let overflowInjected = false;
    try {
      writeSession(path.join(root, 'source.jsonl'), 'overflow-session', [{ type: 'message', id: 'target', timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'user', content: 'bounded source' } }]);
      fs.fstatSync = ((fd: any, options?: any) => {
        const stat = originalFstat(fd, options);
        if (!options?.bigint && stat.isFile()) {
          overflowInjected = true;
          return { ...stat, size: 512 * 1024 * 1024 + 1 };
        }
        return stat;
      }) as typeof fs.fstatSync;
      const result = await capture(db, root).execute('overflow', { session_id: 'overflow-session', entry_id: 'target' });
      assert.equal(overflowInjected, true);
      assert.deepEqual(result.details, { success: false, error: 'transcript_read_limit' });
      assert.equal(result.isError, true);
    } finally { fs.fstatSync = originalFstat; db.close(); }
  });

  it('rejects ambiguous unregistered copies instead of choosing one', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-get-ambiguous-'));
    const db = new DatabaseManager(path.join(root, 'db'));
    try {
      writeSession(path.join(root, 'copy-a.jsonl'), 'ambiguous-session', [{ type: 'message', id: 'entry-a', timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'user', content: 'a' } }]);
      writeSession(path.join(root, 'copy-b.jsonl'), 'ambiguous-session', [{ type: 'message', id: 'entry-b', timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'user', content: 'b' } }]);
      const result = await capture(db, root).execute('ambiguous', { session_id: 'ambiguous-session', entry_id: 'entry-a' });
      assert.deepEqual(result.details, { success: false, error: 'transcript_ambiguous' });
    } finally { db.close(); }
  });

  it('fails closed for unsafe forks and stale entries while round-tripping fail-soft diagnostics', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-get-'));
    const db = new DatabaseManager(root);
    try {
      const fork = path.join(root, 'fork.jsonl');
      writeSession(fork, 'fork-session', [
        { type: 'message', id: 'root', parentId: null, timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'user', content: 'root' } },
        { type: 'message', id: 'left', parentId: 'root', timestamp: '2026-08-09T00:02:00.000Z', message: { role: 'assistant', content: 'left' } },
        { type: 'message', id: 'right', parentId: 'root', timestamp: '2026-08-09T00:03:00.000Z', message: { role: 'assistant', content: 'right' } },
      ]);
      const parsed = parseSessionFile(fork)!;
      indexSession(db, parsed); upsertSessionFileMetadata(db, fork, parsed.id);
      const tool = capture(db);
      assert.equal((await tool.execute('fork', { session_id: 'fork-session', entry_id: 'root', after: 1 })).details.error, 'branch_unresolvable');
      const stale = await tool.execute('stale', { session_id: 'fork-session', entry_id: 'missing' });
      assert.equal(stale.details.error, 'entry_unresolvable');
      assert.equal(stale.isError, true);
      const malformed = path.join(root, 'malformed.jsonl');
      writeSession(malformed, 'malformed-session', [
        { type: 'message', id: 'first', parentId: null, timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'user', content: 'first' } },
        { type: 'message', id: 'ok', parentId: 'first', timestamp: '2026-08-09T00:02:00.000Z', message: { role: 'assistant', content: 'needle target' } },
        { type: 'message', id: 'last', parentId: 'ok', timestamp: '2026-08-09T00:03:00.000Z', message: { role: 'user', content: 'last' } },
      ]);
      fs.appendFileSync(malformed, '{ malformed\n\0unrelated NUL line\n');
      const malformedParsed = parseSessionFile(malformed)!;
      indexSession(db, malformedParsed); upsertSessionFileMetadata(db, malformed, malformedParsed.id);
      const evidence = searchSessionEvidence(db, 'needle', { limit: 1 });
      assert.equal(evidence.results.length, 1);
      const roundTrip = await tool.execute('malformed-round-trip', {
        session_id: evidence.results[0].sessionId,
        entry_id: evidence.results[0].entryId,
        before: 1,
        after: 1,
      });
      assert.equal(roundTrip.details.success, true);
      assert.equal(roundTrip.details.entry.entry_id, 'ok');
      assert.deepEqual(roundTrip.details.before.map((entry: any) => entry.entry_id), ['first']);
      assert.deepEqual(roundTrip.details.after.map((entry: any) => entry.entry_id), ['last']);
      assert.equal(roundTrip.details.diagnostics.malformedLines, 1);
      assert.equal(roundTrip.details.diagnostics.nulLines, 1);
    } finally { db.close(); }
  });

  it('returns an exact fork entry without resolving a distant branch outside the requested window', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-get-'));
    const db = new DatabaseManager(root);
    try {
      const fork = path.join(root, 'distant-fork.jsonl');
      writeSession(fork, 'distant-fork-session', [
        { type: 'message', id: 'root', parentId: null, timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'user', content: 'root' } },
        { type: 'message', id: 'target', parentId: 'root', timestamp: '2026-08-09T00:02:00.000Z', message: { role: 'assistant', content: 'exact target' } },
        { type: 'message', id: 'left', parentId: 'target', timestamp: '2026-08-09T00:03:00.000Z', message: { role: 'user', content: 'left branch' } },
        { type: 'message', id: 'right', parentId: 'target', timestamp: '2026-08-09T00:04:00.000Z', message: { role: 'user', content: 'right branch' } },
      ]);
      const parsed = parseSessionFile(fork)!;
      indexSession(db, parsed); upsertSessionFileMetadata(db, fork, parsed.id);
      const result = await capture(db).execute('exact-fork-entry', { session_id: 'distant-fork-session', entry_id: 'target', before: 0, after: 0 });
      assert.equal(result.details.success, true);
      assert.equal(result.details.entry.entry_id, 'target');
      assert.deepEqual(result.details.before, []);
      assert.deepEqual(result.details.after, []);
    } finally { db.close(); }
  });

  it('supports bounded outline and caps multibyte output at 50 KiB', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-get-'));
    const db = new DatabaseManager(root);
    try {
      const file = path.join(root, 'large.jsonl');
      writeSession(file, 'large-session', [{ type: 'message', id: 'large-entry', timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'user', content: 'Ж😀'.repeat(30_000) } }], `/${'Ж'.repeat(30_000)}`);
      const parsed = parseSessionFile(file)!;
      indexSession(db, parsed); upsertSessionFileMetadata(db, file, parsed.id);
      const result = await capture(db).execute('large', { session_id: 'large-session', entry_id: 'large-entry' });
      assert.ok(Buffer.byteLength(result.content[0].text, 'utf8') <= 50 * 1024);
      assert.ok(Buffer.byteLength(JSON.stringify(result.details), 'utf8') <= 50 * 1024);
      assert.equal(result.details.success, true);
      assert.doesNotMatch(result.details.entry.content, /[\uD800-\uDBFF]$/);
    } finally { db.close(); }
  });

  it('round-trips tool_call and tool_result anchors when tool output is explicitly indexed', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-get-'));
    const db = new DatabaseManager(root);
    try {
      const file = path.join(root, 'tools.jsonl');
      writeSession(file, 'tool-round-trip', [
        { type: 'message', id: 'call', parentId: null, timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'shell', id: 'call-1' }] } },
        { type: 'message', id: 'result', parentId: 'call', timestamp: '2026-08-09T00:02:00.000Z', message: { role: 'toolResult', content: [{ type: 'tool_result', toolCallId: 'call-1', content: 'tool output' }] } },
      ]);
      const parsed = parseSessionFile(file)!;
      indexSession(db, parsed); upsertSessionFileMetadata(db, file, parsed.id);
      const tool = capture(db);
      const call = await tool.execute('call', { session_id: 'tool-round-trip', entry_id: 'call' });
      const result = await tool.execute('result', { session_id: 'tool-round-trip', entry_id: 'result' });
      assert.equal(call.details.success, true);
      assert.equal(call.details.entry.kind, 'tool_call');
      assert.equal(call.details.entry.tool_name, 'shell');
      assert.equal(result.details.success, true);
      assert.equal(result.details.entry.kind, 'tool_result');
      assert.equal(result.details.entry.tool_call_id, 'call-1');
    } finally { db.close(); }
  });

  it('keeps oversized tool metadata inside valid bounded JSON', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-get-'));
    const db = new DatabaseManager(root);
    try {
      const file = path.join(root, 'huge-tools.jsonl');
      writeSession(file, 'huge-tools', [{
        type: 'message', id: 'huge-tool', timestamp: '2026-08-09T00:01:00.000Z',
        message: { role: 'assistant', toolName: 'tool-' + 'x'.repeat(30_000), toolCallId: 'call-' + 'y'.repeat(30_000), content: Array.from({ length: 30_000 }, (_, index) => ({ type: 'toolCall', name: `shell-${index}`, id: `call-${index}` })) },
      }]);
      const parsed = parseSessionFile(file)!;
      indexSession(db, parsed); upsertSessionFileMetadata(db, file, parsed.id);
      const output = await capture(db).execute('huge', { session_id: 'huge-tools', entry_id: 'huge-tool' });
      const text = output.content[0].text as string;
      assert.doesNotThrow(() => JSON.parse(text));
      assert.ok(Buffer.byteLength(text, 'utf8') <= 50 * 1024);
      assert.ok(Buffer.byteLength(JSON.stringify(output.details), 'utf8') <= 50 * 1024);
    } finally { db.close(); }
  });

  it('rejects traversal and symlink escapes for index and get', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-get-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'session-outside-'));
    const db = new DatabaseManager(root);
    try {
      const outsideFile = path.join(outside, 'escape.jsonl');
      writeSession(outsideFile, 'escape-session', [{ type: 'message', id: 'escape-entry', timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'user', content: 'secret' } }]);
      fs.symlinkSync(outside, path.join(root, 'linked'), 'dir');
      const indexResult = indexAllSessions(db, root, '../' + path.basename(outside));
      assert.equal(indexResult.sessionsIndexed, 0);
      indexSession(db, parseSessionFile(outsideFile)!);
      upsertSessionFileMetadata(db, outsideFile, 'escape-session');
      const result = await capture(db, root).execute('escape', { session_id: 'escape-session', entry_id: 'escape-entry' });
      assert.equal(result.details.error, 'transcript_unavailable');
    } finally { db.close(); fs.rmSync(outside, { recursive: true, force: true }); }
  });

  it('exposes the actual session_get tool schema', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-get-'));
    const db = new DatabaseManager(root);
    try {
      const tool = capture(db);
      const schema = JSON.stringify(tool.parameters);
      assert.equal(tool.name, 'session_get');
      assert.match(schema, /session_id/);
      assert.match(schema, /entry_id/);
      assert.match(schema, /before/);
      assert.match(schema, /outline/);
    } finally { db.close(); }
  });

  it('fails explicitly when an exact identity cannot fit the response budget', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-get-identity-'));
    const db = new DatabaseManager(root);
    try {
      const ids = ['x'.repeat(65_000), 'Ж😀'.repeat(10_000), '"\\'.repeat(20_000)];
      for (const [index, entryId] of ids.entries()) {
        const file = path.join(root, `entry-${index}.jsonl`);
        const sessionId = `large-identity-${index}`;
        writeSession(file, sessionId, [{ type: 'message', id: entryId, timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'user', content: 'small content' } }]);
        const parsed = parseSessionFile(file)!;
        indexSession(db, parsed); upsertSessionFileMetadata(db, file, parsed.id);
        const result = await capture(db).execute('large-id', { session_id: sessionId, entry_id: entryId });
        assert.deepEqual(result.details, { success: false, error: 'session_get_response_limit' });
        assert.equal(result.isError, true);
        assert.ok(Buffer.byteLength(result.content[0].text, 'utf8') <= 50 * 1024);
        assert.ok(Buffer.byteLength(JSON.stringify(result.details), 'utf8') <= 50 * 1024);
        assert.deepEqual(JSON.parse(result.content[0].text), result.details);
      }
      const file = path.join(root, 'session-identity.jsonl');
      const sessionId = 's'.repeat(65_000);
      writeSession(file, sessionId, []);
      const parsed = parseSessionFile(file)!;
      indexSession(db, parsed); upsertSessionFileMetadata(db, file, parsed.id);
      const metadata = await capture(db).execute('large-session-id', { session_id: sessionId, view: 'metadata' });
      assert.deepEqual(metadata.details, { success: false, error: 'session_get_response_limit' });
      assert.equal(metadata.isError, true);
    } finally { db.close(); }
  });

  it('preserves full session identities and anchors when they fit the response budget', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-get-exact-id-'));
    const db = new DatabaseManager(root);
    try {
      const sessionId = 's'.repeat(2_000), entryId = 'e'.repeat(2_000);
      const file = path.join(root, 'exact-identity.jsonl');
      writeSession(file, sessionId, [{ type: 'message', id: entryId, timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'user', content: 'content' } }]);
      const parsed = parseSessionFile(file)!;
      indexSession(db, parsed); upsertSessionFileMetadata(db, file, parsed.id);
      const result = await capture(db).execute('exact', { session_id: sessionId, entry_id: entryId });
      assert.equal(result.details.success, true);
      assert.equal(result.details.session.session_id, sessionId);
      assert.equal(result.details.entry.entry_id, entryId);
      assert.equal(result.details.entry.anchor, `pi://session/${sessionId}#entry=${entryId}`);
      assert.ok(Buffer.byteLength(JSON.stringify(result.details), 'utf8') <= 50 * 1024);
    } finally { db.close(); }
  });

  it('rejects cycles within requested context without blocking an exact isolated read', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-get-cycle-'));
    const db = new DatabaseManager(root);
    try {
      const file = path.join(root, 'cycle.jsonl');
      writeSession(file, 'cycle-session', [
        { type: 'message', id: 'target', parentId: 'target', timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'user', content: 'exact cyclic record' } },
      ]);
      const parsed = parseSessionFile(file)!;
      indexSession(db, parsed); upsertSessionFileMetadata(db, file, parsed.id);
      const tool = capture(db);
      const exact = await tool.execute('cycle-exact', { session_id: 'cycle-session', entry_id: 'target', before: 0, after: 0 });
      assert.equal(exact.details.success, true);
      for (const context of [{ before: 1, after: 0 }, { before: 0, after: 1 }]) {
        const result = await tool.execute('cycle-context', { session_id: 'cycle-session', entry_id: 'target', ...context });
        assert.equal(result.details.success, false);
        assert.equal(result.details.error, 'branch_unresolvable');
      }
    } finally { db.close(); }
  });
});
