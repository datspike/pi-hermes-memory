import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { DatabaseManager, SESSION_REPAIR_VERSION, SessionEvidenceUnavailableError } from '../../src/store/db.js';
import { SCHEMA_SQL } from '../../src/store/schema.js';
import { isBunRuntime } from '../../src/store/sqlite-native.js';
import { indexSession, upsertSessionFileMetadata } from '../../src/store/session-indexer.js';
import { parseSessionFile } from '../../src/store/session-parser.js';
import { searchSessionEvidence } from '../../src/store/session-search.js';
import { registerSessionGetTool } from '../../src/tools/session-get-tool.js';
import { waitForSessionRepairMigration } from '../../src/handlers/session-repair-migration.js';

function aliasFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-alias-'));
  const real = path.join(root, 'real-sessions'); fs.mkdirSync(real);
  const alias = path.join(root, 'sessions-alias'); fs.symlinkSync(real, alias, 'dir');
  const file = path.join(alias, 'session.jsonl');
  fs.writeFileSync(file, [
    { type: 'session', id: 'alias-session', cwd: '/fixture', timestamp: '2026-10-02T00:00:00Z' },
    { type: 'message', id: 'entry', timestamp: '2026-10-02T00:00:00Z', message: { role: 'user', content: 'needle canonical alias' } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  const manager = new DatabaseManager(path.join(root, 'memory'));
  const session = parseSessionFile(file)!;
  let tool: any;
  registerSessionGetTool({ registerTool: (value: any) => { tool = value; } } as any, manager, { sessionsDir: alias });
  return { root, alias, file, manager, session, tool };
}
function counts(manager: DatabaseManager) {
  return ['session_files', 'sessions', 'messages'].map(table => (manager.getDb().prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
}

function repairFixture(legacy = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-repair-'));
  const require = createRequire(import.meta.url);
  const Database = isBunRuntime() ? require('bun:sqlite').Database : require('better-sqlite3');
  const raw = new Database(path.join(root, 'sessions.db'));
  raw.exec(legacy ? SCHEMA_SQL.replace(/,\s*tokenize='trigram'/g, '') : SCHEMA_SQL);
  raw.exec(`PRAGMA user_version = ${SESSION_REPAIR_VERSION}`);
  raw.prepare('INSERT INTO extension_metadata(key,value) VALUES (?,?)').run('session_repair_state:v1', JSON.stringify({
    version: 1, status: 'complete', cursor: 0, total: 1, processed: 1, updatedAt: '2026-10-02T00:00:00Z',
  }));
  raw.prepare('INSERT INTO sessions(id,project,cwd,started_at) VALUES (?,?,?,?)').run('repair', 'fixture', '/fixture', '2026-10-02T00:00:00Z');
  raw.prepare('INSERT INTO messages(id,session_id,entry_id,role,content,timestamp) VALUES (?,?,?,?,?,?)')
    .run('physical', 'repair', 'entry', 'user', 'needle', '2026-10-02T00:00:00Z');
  raw.close(); return root;
}

/** Construct damaged fixtures without weakening the tested Node/Bun production connections. */
function damageFtsFixture(root: string, mode: 'keys' | 'missing-docsize' | 'invalid-docsize'): void {
  const nativeModule = createRequire(import.meta.url).resolve('better-sqlite3');
  execFileSync(isBunRuntime() ? 'node' : process.execPath, ['--max-old-space-size=256', '-e', `
    const Database = require(process.argv[1]);
    const db = new Database(process.argv[2]);
    db.unsafeMode(true);
    try {
      if (process.argv[3] === 'keys') {
        const row = db.prepare('SELECT sz FROM message_fts_docsize WHERE id = 1').get();
        db.exec('DELETE FROM message_fts_docsize');
        db.prepare('INSERT INTO message_fts_docsize(id,sz) VALUES (?,?)').run(999, row.sz);
      } else {
        db.exec('DROP TABLE message_fts_docsize');
        if (process.argv[3] === 'invalid-docsize') db.exec('CREATE TABLE message_fts_docsize(id,sz)');
      }
    } finally { db.close(); }
  `, nativeModule, path.join(root, 'sessions.db'), mode], { timeout: 20_000 });
}

describe('canonical owner recovery and shutdown lifecycle', () => {
  it('preserves shutdown-indexed evidence when session_get uses a symlink sessions root', async () => {
    const f = aliasFixture();
    try {
      indexSession(f.manager, f.session);
      upsertSessionFileMetadata(f.manager, f.file, f.session.id);
      const before = counts(f.manager);
      const result = await f.tool.execute('get', { session_id: f.session.id, entry_id: 'entry' });
      assert.equal(result.details.success, true);
      assert.equal(result.details.entry.anchor, 'pi://session/alias-session#entry=entry');
      assert.deepEqual(counts(f.manager), before);
      const stored = f.manager.getDb().prepare('SELECT path FROM session_files').get() as { path: string };
      assert.equal(stored.path, fs.realpathSync(f.file));
      assert.equal(searchSessionEvidence(f.manager, 'needle', { sessionsDir: f.alias }).results.length, 1);
    } finally { assert.equal(f.manager.close(), true); fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('keeps a pre-existing lexical alias owner while removing only missing owners', async () => {
    const f = aliasFixture();
    try {
      indexSession(f.manager, f.session);
      const canonical = fs.realpathSync(f.file);
      upsertSessionFileMetadata(f.manager, canonical, f.session.id);
      const db = f.manager.getDb();
      db.prepare('UPDATE session_files SET path = ? WHERE path = ?').run(f.file, canonical);
      db.prepare('INSERT INTO session_files(path,session_id,size,mtime_ms,indexed_at) VALUES (?,?,?,?,?)')
        .run(path.join(f.alias, 'missing.jsonl'), f.session.id, 0, 0, '2026-10-03T00:00:00Z');
      const result = await f.tool.execute('legacy-alias', { session_id: f.session.id, entry_id: 'entry' });
      assert.equal(result.details.success, true);
      assert.deepEqual(counts(f.manager), [1, 1, 1]);
      const stored = db.prepare('SELECT path FROM session_files').get() as { path: string };
      assert.equal(stored.path, f.file);
      assert.equal(searchSessionEvidence(f.manager, 'needle', { sessionsDir: f.alias }).results.length, 1);
    } finally { assert.equal(f.manager.close(), true); fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('reaps a blocked FTS worker before a timed-out shutdown can close its original database', async () => {
    const root = repairFixture();
    const require = createRequire(import.meta.url);
    const Database = isBunRuntime() ? require('bun:sqlite').Database : require('better-sqlite3');
    const manager = new DatabaseManager(root); manager.setQuickCheckOnOpen(false);
    const blocker = new Database(path.join(root, 'sessions.db'));
    const controller = new AbortController();
    let task: ReturnType<DatabaseManager['runSessionRepairChunk']> | undefined;
    try {
      manager.getDb();
      const native = (manager as any).native;
      blocker.exec('BEGIN IMMEDIATE');
      task = manager.runSessionRepairChunk({ signal: controller.signal });
      const pid = (manager as any).ftsRepairProcess.child.pid;
      const completed = await waitForSessionRepairMigration(100, {
        inProgress: true, promise: task.then(() => undefined),
        cancel: () => { controller.abort(); blocker.exec('ROLLBACK'); },
      });
      assert.equal(completed, false);
      assert.throws(() => process.kill(pid, 0), (error: any) => error.code === 'ESRCH');
      assert.equal(manager.close(), true);
      assert.throws(() => native.prepare('SELECT 1').get());
      assert.equal((await task)?.status, 'aborted');
    } finally {
      try { blocker.exec('ROLLBACK'); } catch {}
      controller.abort(); await task?.catch(() => {});
      blocker.close(); assert.equal(manager.close(), true);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores a missing complete FTS index without modifying source messages', async () => {
    const root = repairFixture(false);
    const require = createRequire(import.meta.url);
    const Database = isBunRuntime() ? require('bun:sqlite').Database : require('better-sqlite3');
    const raw = new Database(path.join(root, 'sessions.db'));
    raw.exec('DROP TABLE message_fts'); raw.close();
    const manager = new DatabaseManager(root); manager.setQuickCheckOnOpen(false);
    try {
      const db = manager.getDb();
      const before = db.prepare('SELECT * FROM messages').all();
      assert.notEqual(manager.getSessionRepairState()?.status, 'complete');
      assert.throws(() => manager.assertSessionEvidenceAvailable(), SessionEvidenceUnavailableError);
      for (let steps = 0; steps < 50 && manager.getSessionRepairState()?.status !== 'complete'; steps++) {
        await manager.runSessionRepairChunk({ chunkSize: 2 });
      }
      assert.equal(manager.getSessionRepairState()?.status, 'complete');
      assert.deepEqual(db.prepare('SELECT * FROM messages').all(), before);
      const hits = db.prepare("SELECT count(*) AS n FROM message_fts WHERE message_fts MATCH 'needle NOT forbidden'").get() as { n: number };
      assert.equal(hits.n, 1);
    } finally { assert.equal(manager.close(), true); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('repairs a no-op insert trigger before publishing complete and preserves native identity defaults', async () => {
    const root = repairFixture(false);
    const require = createRequire(import.meta.url);
    const Database = isBunRuntime() ? require('bun:sqlite').Database : require('better-sqlite3');
    const raw = new Database(path.join(root, 'sessions.db'));
    raw.exec('DROP TRIGGER messages_ai; CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN SELECT 1; END;');
    raw.close();
    const manager = new DatabaseManager(root); manager.setQuickCheckOnOpen(false);
    try {
      const db = manager.getDb();
      for (let steps = 0; steps < 50 && manager.getSessionRepairState()?.status !== 'complete'; steps++) {
        await manager.runSessionRepairChunk({ chunkSize: 2 });
      }
      assert.equal(manager.getSessionRepairState()?.status, 'complete');
      db.prepare('INSERT INTO messages(id,session_id,role,content,timestamp) VALUES (?,?,?,?,?)')
        .run('future-physical', 'repair', 'user', 'future searchable', '2026-10-02T00:01:00Z');
      const result = db.prepare("SELECT count(*) AS n FROM message_fts WHERE message_fts MATCH 'future NOT forbidden'").get() as { n: number };
      assert.equal(result.n, 1);
      const identity = db.prepare('SELECT entry_id FROM messages WHERE id = ?').get('future-physical') as { entry_id: string };
      assert.equal(identity.entry_id, 'future-physical');
    } finally { assert.equal(manager.close(), true); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('detects different source keys even when docsize cardinality is unchanged', async () => {
    const root = repairFixture(false);
    damageFtsFixture(root, 'keys');
    const manager = new DatabaseManager(root); manager.setQuickCheckOnOpen(false);
    try {
      const db = manager.getDb();
      const before = db.prepare('SELECT * FROM messages').all();
      for (let steps = 0; steps < 50 && manager.getSessionRepairState()?.status !== 'complete'; steps++) await manager.runSessionRepairChunk({ chunkSize: 2 });
      assert.equal(manager.getSessionRepairState()?.status, 'complete');
      assert.deepEqual(db.prepare('SELECT id FROM message_fts_docsize').all(), [{ id: 1 }]);
      assert.deepEqual(db.prepare('SELECT * FROM messages').all(), before);
      assert.equal((db.prepare("SELECT count(*) AS n FROM message_fts WHERE message_fts MATCH 'needle'").get() as { n: number }).n, 1);
    } finally { assert.equal(manager.close(), true); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('recreates a missing docsize shadow without discarding source data', async () => {
    const root = repairFixture(false);
    damageFtsFixture(root, 'missing-docsize');
    const manager = new DatabaseManager(root); manager.setQuickCheckOnOpen(false);
    try {
      const db = manager.getDb();
      const before = db.prepare('SELECT * FROM messages').all();
      assert.notEqual(manager.getSessionRepairState()?.status, 'complete');
      for (let steps = 0; steps < 50 && manager.getSessionRepairState()?.status !== 'complete'; steps++) await manager.runSessionRepairChunk({ chunkSize: 2 });
      assert.equal(manager.getSessionRepairState()?.status, 'complete');
      assert.deepEqual(db.prepare('SELECT * FROM messages').all(), before);
      assert.equal((db.prepare("SELECT count(*) AS n FROM message_fts WHERE message_fts MATCH 'needle'").get() as { n: number }).n, 1);
    } finally { assert.equal(manager.close(), true); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects a docsize schema with correct column names but missing key constraints', async () => {
    const root = repairFixture(false);
    damageFtsFixture(root, 'invalid-docsize');
    const manager = new DatabaseManager(root); manager.setQuickCheckOnOpen(false);
    try {
      const db = manager.getDb();
      const before = db.prepare('SELECT * FROM messages').all();
      assert.equal(manager.getSessionRepairState()?.phase, 'message_fts');
      for (let steps = 0; steps < 50 && manager.getSessionRepairState()?.status !== 'complete'; steps++) await manager.runSessionRepairChunk({ chunkSize: 2 });
      assert.equal(manager.getSessionRepairState()?.status, 'complete');
      assert.deepEqual(db.prepare('SELECT * FROM messages').all(), before);
      const columns = db.prepare('PRAGMA table_info(message_fts_docsize)').all() as { name: string; type: string; pk: number }[];
      assert.equal(columns.find(column => column.name === 'id')?.type, 'INTEGER');
      assert.equal(columns.find(column => column.name === 'id')?.pk, 1);
    } finally { assert.equal(manager.close(), true); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('allows a bounded five-minute initial FTS recreation while ordinary chunks retain sixty seconds', async () => {
    const root = repairFixture();
    const manager = new DatabaseManager(root); manager.setQuickCheckOnOpen(false);
    const originalSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      delays.push(Number(delay));
      return originalSetTimeout(callback, delay, ...args);
    }) as typeof globalThis.setTimeout;
    try {
      await manager.runSessionRepairChunk({ chunkSize: 2 });
      assert.ok(delays.includes(300_000), `Initial recreation deadlines: ${delays.join(',')}`);
      delays.length = 0;
      await manager.runSessionRepairChunk({ chunkSize: 2 });
      assert.ok(delays.includes(60_000), `Ordinary chunk deadlines: ${delays.join(',')}`);
      assert.equal(delays.includes(300_000), false);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      assert.equal(manager.close(), true); fs.rmSync(root, { recursive: true, force: true });
    }
  });

  for (const legacy of [false, true]) it(`keeps full integrity verification ${legacy ? 'after a rebuild' : 'separate from healthy coverage'}`, async () => {
    const root = repairFixture(legacy);
    const manager = new DatabaseManager(root); manager.setQuickCheckOnOpen(false);
    const original = (manager as any).verifySessionRepairInWorker;
    const calls: { coverage: boolean; fullIntegrity: boolean }[] = [];
    (manager as any).verifySessionRepairInWorker = async function(signal?: AbortSignal, coverage = true, fullIntegrity = true) {
      calls.push({ coverage, fullIntegrity });
      return original.call(this, signal, coverage, fullIntegrity);
    };
    try {
      for (let steps = 0; steps < 50 && manager.getSessionRepairState()?.status !== 'complete'; steps++) await manager.runSessionRepairChunk({ chunkSize: 2 });
      assert.equal(manager.getSessionRepairState()?.status, 'complete');
      assert.deepEqual(calls, [{ coverage: true, fullIntegrity: legacy }]);
    } finally { assert.equal(manager.close(), true); fs.rmSync(root, { recursive: true, force: true }); }
  });

  for (const table of ['messages', 'memories'] as const) for (const [suffix, operation] of [['ai', 'INSERT'], ['ad', 'DELETE'], ['au', 'UPDATE']] as const) {
    it(`repairs a no-op ${table}_${suffix} before subsequent insert/update/delete operations`, async () => {
      const root = repairFixture(false);
      const require = createRequire(import.meta.url);
      const Database = isBunRuntime() ? require('bun:sqlite').Database : require('better-sqlite3');
      const raw = new Database(path.join(root, 'sessions.db'));
      if (table === 'memories') raw.prepare('INSERT INTO memories(target,content,created,last_referenced) VALUES (?,?,?,?)').run('memory', 'needle memory', '2026-10-02', '2026-10-02');
      raw.exec(`DROP TRIGGER ${table}_${suffix}; CREATE TRIGGER ${table}_${suffix} AFTER ${operation} ON ${table} BEGIN SELECT 1; END;`); raw.close();
      const manager = new DatabaseManager(root); manager.setQuickCheckOnOpen(false);
      const fts = table === 'messages' ? 'message_fts' : 'memory_fts';
      const key = table === 'messages' ? 'rowid' : 'id';
      try {
        const db = manager.getDb();
        const before = db.prepare(`SELECT * FROM ${table}`).all();
        for (let steps = 0; steps < 50 && manager.getSessionRepairState()?.status !== 'complete'; steps++) await manager.runSessionRepairChunk({ chunkSize: 2 });
        assert.equal(manager.getSessionRepairState()?.status, 'complete');
        assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), before);
        if (table === 'messages') db.prepare('INSERT INTO messages(id,session_id,role,content,timestamp) VALUES (?,?,?,?,?)').run('added', 'repair', 'user', 'insertword', '2026-10-02T00:01:00Z');
        else db.prepare('INSERT INTO memories(target,content,created,last_referenced) VALUES (?,?,?,?)').run('memory', 'insertword', '2026-10-02', '2026-10-02');
        assert.equal((db.prepare(`SELECT count(*) AS n FROM ${fts} WHERE ${fts} MATCH 'insertword'`).get() as { n: number }).n, 1);
        db.exec(`UPDATE ${table} SET content = 'freshword' WHERE ${key} = 1`);
        assert.equal((db.prepare(`SELECT count(*) AS n FROM ${fts} WHERE ${fts} MATCH 'freshword'`).get() as { n: number }).n, 1);
        db.exec(`DELETE FROM ${table} WHERE ${key} = 1`);
        assert.equal((db.prepare(`SELECT count(*) AS n FROM ${fts} WHERE ${fts} MATCH 'freshword'`).get() as { n: number }).n, 0);
      } finally { assert.equal(manager.close(), true); fs.rmSync(root, { recursive: true, force: true }); }
    });
  }
});
