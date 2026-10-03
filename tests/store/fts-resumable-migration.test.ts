import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isBunRuntime } from '../../src/store/sqlite-native.js';
import { DatabaseManager, SESSION_REPAIR_VERSION, SessionEvidenceUnavailableError } from '../../src/store/db.js';
import { SCHEMA_SQL } from '../../src/store/schema.js';
import { searchMemories } from '../../src/store/sqlite-memory-store.js';

const require = createRequire(import.meta.url);
const Database = isBunRuntime() ? require('bun:sqlite').Database : require('better-sqlite3');

function legacyFixture(count = 7): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fts-resumable-'));
  const db = new Database(path.join(root, 'sessions.db'));
  db.exec(SCHEMA_SQL.replace(/,\s*tokenize='trigram'/g, ''));
  db.exec(`PRAGMA user_version = ${SESSION_REPAIR_VERSION}`);
  db.prepare('INSERT INTO extension_metadata(key, value) VALUES (?, ?)').run('session_repair_state:v1', JSON.stringify({
    version: 1, status: 'complete', cursor: 0, total: 0, processed: 0,
    updatedAt: '2026-10-01T00:00:00Z', completedAt: '2026-10-01T00:00:00Z',
  }));
  db.prepare('INSERT INTO sessions(id, project, cwd, started_at) VALUES (?, ?, ?, ?)').run('session', 'fixture', '/fixture', '2026-10-01T00:00:00Z');
  const insert = db.prepare('INSERT INTO messages(id, session_id, entry_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < count; i++) insert.run(`physical-${i}`, 'session', `entry-${i}`, 'user', `设备清单 alpha message ${i}`, '2026-10-01T00:00:00Z');
  db.prepare('INSERT INTO memories(target, content, created, last_referenced) VALUES (?, ?, ?, ?)').run('memory', '设备清单 durable memory', '2026-10-01', '2026-10-01');
  db.close();
  return root;
}

async function finish(manager: DatabaseManager): Promise<number> {
  for (let steps = 0; steps < 300; steps++) {
    if (manager.getSessionRepairState()?.status === 'complete') return steps;
    await manager.runSessionRepairChunk({ chunkSize: 2, wallClockBudgetMs: 10 });
  }
  throw new Error('Migration did not finish within the fixture step bound');
}

function sourceRows(manager: DatabaseManager): unknown[] {
  return manager.getDb().prepare('SELECT id, entry_id, content FROM messages ORDER BY rowid').all();
}

function tokenizer(manager: DatabaseManager, table: string): string {
  return (manager.getDb().prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as { sql: string }).sql;
}

describe('resumable trigram migration', () => {
  it('queues work on open without synchronously replacing or rebuilding the indexes', async () => {
    const root = legacyFixture();
    const manager = new DatabaseManager(root);
    manager.setQuickCheckOnOpen(false);
    try {
      const before = sourceRows(manager);
      assert.equal(manager.getSessionRepairState()?.status, 'pending');
      assert.equal(manager.getSessionRepairState()?.phase, 'message_fts');
      assert.doesNotMatch(tokenizer(manager, 'message_fts'), /trigram/);
      assert.throws(() => manager.assertSessionEvidenceAvailable(), SessionEvidenceUnavailableError);
      assert.throws(() => searchMemories(manager, 'durable'), SessionEvidenceUnavailableError);
      assert.ok(await finish(manager) > 3);
      assert.match(tokenizer(manager, 'message_fts'), /trigram/);
      assert.match(tokenizer(manager, 'memory_fts'), /trigram/);
      assert.deepEqual(sourceRows(manager), before);
      assert.equal(manager.getDb().prepare('SELECT count(*) AS count FROM message_fts WHERE message_fts MATCH ?').get('设备清单').count, 7);
      assert.equal(searchMemories(manager, '设备清单')[0]?.content, '设备清单 durable memory');
      assert.deepEqual(manager.getDb().prepare('SELECT value FROM extension_metadata WHERE key = ?').get('fts5_tokenizer_version'), { value: 'trigram-v1' });
    } finally {
      manager.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves phase and cursor across close and reopen in either FTS phase', async () => {
    const root = legacyFixture(12);
    let manager = new DatabaseManager(root);
    manager.setQuickCheckOnOpen(false);
    try {
      const before = sourceRows(manager);
      for (const phase of ['message_fts', 'memory_fts'] as const) {
        for (let steps = 0; steps < 100; steps++) {
          const state = manager.getSessionRepairState();
          if (state?.phase === phase && state.ftsInitialized) break;
          await manager.runSessionRepairChunk({ chunkSize: 2 });
        }
        assert.equal(manager.getSessionRepairState()?.phase, phase);
        if (phase === 'message_fts') await manager.runSessionRepairChunk({ chunkSize: 2 });
        const state = manager.getSessionRepairState();
        manager.close();
        manager = new DatabaseManager(root);
        manager.setQuickCheckOnOpen(false);
        const reopened = manager.getSessionRepairState();
        assert.equal(reopened?.phase, state?.phase);
        assert.equal(reopened?.cursor, state?.cursor);
        assert.equal(reopened?.ftsInitialized, state?.ftsInitialized);
      }
      await finish(manager);
      assert.deepEqual(sourceRows(manager), before);
    } finally {
      manager.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists cancellation and resumes without dropping source data', async () => {
    const root = legacyFixture();
    const manager = new DatabaseManager(root);
    manager.setQuickCheckOnOpen(false);
    try {
      const before = sourceRows(manager);
      await manager.runSessionRepairChunk({ chunkSize: 2 });
      const cursor = manager.getSessionRepairState()?.cursor;
      const signal = AbortSignal.abort();
      await manager.runSessionRepairChunk({ signal });
      assert.equal(manager.getSessionRepairState()?.status, 'aborted');
      assert.equal(manager.getSessionRepairState()?.cursor, cursor);
      await finish(manager);
      assert.deepEqual(sourceRows(manager), before);
    } finally {
      manager.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('verifies complete indexes asynchronously on reopen without rebuilding healthy postings', async () => {
    const root = legacyFixture();
    let manager = new DatabaseManager(root);
    manager.setQuickCheckOnOpen(false);
    const postings = () => ['message_fts', 'memory_fts'].map(table => ({
      data: manager.getDb().prepare(`SELECT * FROM ${table}_data ORDER BY id`).all(),
      index: manager.getDb().prepare(`SELECT * FROM ${table}_idx ORDER BY segid, term`).all(),
      docsize: manager.getDb().prepare(`SELECT * FROM ${table}_docsize ORDER BY id`).all(),
    }));
    try {
      await finish(manager);
      const before = postings();
      const messages = sourceRows(manager);
      const schemaVersion = (manager.getDb().prepare('PRAGMA schema_version').get() as { schema_version: number }).schema_version;
      manager.close();
      manager = new DatabaseManager(root);
      manager.setQuickCheckOnOpen(false);
      assert.equal(manager.getSessionRepairState()?.status, 'pending');
      assert.equal(manager.getSessionRepairState()?.phase, 'coverage');
      assert.throws(() => manager.assertSessionEvidenceAvailable(), SessionEvidenceUnavailableError);
      assert.equal(await finish(manager), 1);
      assert.deepEqual(postings(), before);
      assert.deepEqual(sourceRows(manager), messages);
      assert.equal((manager.getDb().prepare('PRAGMA schema_version').get() as { schema_version: number }).schema_version, schemaVersion);
    } finally {
      manager.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows concurrent updates and deletes before source rows enter the new index', async () => {
    const root = legacyFixture(12);
    const manager = new DatabaseManager(root);
    const writer = new DatabaseManager(root);
    manager.setQuickCheckOnOpen(false);
    writer.setQuickCheckOnOpen(false);
    try {
      manager.getDb();
      await manager.runSessionRepairChunk({ chunkSize: 2 });
      const db = writer.getDb();
      db.prepare('UPDATE messages SET content = ? WHERE entry_id = ?').run('updated canonical tail', 'entry-10');
      db.prepare('DELETE FROM messages WHERE entry_id = ?').run('entry-11');
      const expected = sourceRows(manager);
      for (let steps = 0; steps < 100; steps++) {
        const state = manager.getSessionRepairState();
        if (state?.phase === 'memory_fts' && state.ftsInitialized) break;
        await manager.runSessionRepairChunk({ chunkSize: 2 });
      }
      assert.equal(manager.getSessionRepairState()?.phase, 'memory_fts');
      db.prepare('UPDATE memories SET content = ? WHERE id = 1').run('updated durable memory');
      db.prepare('INSERT INTO memories(target, content, created, last_referenced) VALUES (?, ?, ?, ?)').run('memory', 'new durable memory', '2026-10-01', '2026-10-01');
      await finish(manager);
      assert.deepEqual(sourceRows(manager), expected);
      assert.equal(searchMemories(manager, 'updated durable')[0]?.content, 'updated durable memory');
      assert.equal(searchMemories(manager, 'new durable')[0]?.content, 'new durable memory');
      assert.equal(manager.getDb().prepare('SELECT count(*) AS count FROM message_fts WHERE message_fts MATCH ?').get('"updated canonical tail"').count, 1);
      const trigger = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get('messages_ad') as { sql: string };
      assert.doesNotMatch(trigger.sql, /docsize/);
    } finally {
      writer.close();
      manager.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('serializes repair chunks across managers and publishes complete coverage once', async () => {
    const root = legacyFixture(12);
    const manager = new DatabaseManager(root);
    const peer = new DatabaseManager(root);
    manager.setQuickCheckOnOpen(false);
    peer.setQuickCheckOnOpen(false);
    try {
      const before = sourceRows(manager);
      peer.getDb();
      for (let steps = 0; steps < 100 && manager.getSessionRepairState()?.status !== 'complete'; steps++) {
        await Promise.all([manager.runSessionRepairChunk({ chunkSize: 2 }), peer.runSessionRepairChunk({ chunkSize: 2 })]);
      }
      assert.equal(manager.getSessionRepairState()?.status, 'complete');
      assert.equal(peer.getSessionRepairState()?.status, 'complete');
      assert.deepEqual(sourceRows(manager), before);
      assert.equal(manager.getDb().prepare('SELECT count(*) AS count FROM message_fts WHERE message_fts MATCH ?').get('设备清单').count, 12);
    } finally {
      peer.close();
      manager.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('cancels a native-blocked worker without freezing the parent and reaps it before resuming', async () => {
    const root = legacyFixture();
    const manager = new DatabaseManager(root);
    manager.setQuickCheckOnOpen(false);
    const blocker = new Database(path.join(root, 'sessions.db'));
    const controller = new AbortController();
    let lastTick = Date.now();
    let maximumGap = 0;
    const ticks = setInterval(() => {
      const now = Date.now();
      maximumGap = Math.max(maximumGap, now - lastTick);
      lastTick = now;
    }, 5);
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const before = sourceRows(manager);
      blocker.exec('BEGIN IMMEDIATE');
      const task = manager.runSessionRepairChunk({ signal: controller.signal });
      const internal = manager as unknown as { ftsRepairProcess: { child: { pid: number } } };
      const pid = internal.ftsRepairProcess.child.pid;
      cancelTimer = setTimeout(() => { controller.abort(); blocker.exec('ROLLBACK'); }, 100);
      const state = await task;
      assert.equal(state?.status, 'aborted');
      assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as { code: string }).code === 'ESRCH');
      assert.ok(maximumGap < 250, `Parent timer gap was ${maximumGap} ms`);
      clearInterval(ticks);
      await finish(manager);
      assert.deepEqual(sourceRows(manager), before);
    } finally {
      if (cancelTimer) clearTimeout(cancelTimer);
      clearInterval(ticks);
      blocker.close();
      manager.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('legacy memory target migration', () => {
  for (const tokenizerName of ['unicode61', 'trigram']) {
    it(`keeps new inserts, updates and deletes searchable after the old target CHECK with ${tokenizerName}`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fts-target-check-'));
      const raw = new Database(path.join(root, 'sessions.db'));
      const oldCheck = "target TEXT NOT NULL CHECK (target IN ('memory', 'user'))";
      raw.exec(SCHEMA_SQL.replace("target TEXT NOT NULL CHECK (target IN ('memory', 'user', 'failure'))", oldCheck).replaceAll("tokenize='trigram'", `tokenize='${tokenizerName}'`));
      raw.prepare('INSERT INTO memories(target, content, created, last_referenced) VALUES (?, ?, ?, ?)').run('memory', 'preserved legacy content', '2026-10-01', '2026-10-01');
      raw.close();
      const manager = new DatabaseManager(root);
      manager.setQuickCheckOnOpen(false);
      try {
        await finish(manager);
        const db = manager.getDb();
        assert.equal(searchMemories(manager, 'preserved')[0]?.content, 'preserved legacy content');
        const inserted = db.prepare('INSERT INTO memories(target, content, created, last_referenced) VALUES (?, ?, ?, ?)').run('memory', 'newly inserted needle', '2026-10-02', '2026-10-02');
        assert.equal(searchMemories(manager, 'needle').length, 1);
        db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('updated marker', inserted.lastInsertRowid);
        assert.equal(searchMemories(manager, 'needle').length, 0);
        assert.equal(searchMemories(manager, 'marker').length, 1);
        db.prepare('DELETE FROM memories WHERE id = ?').run(inserted.lastInsertRowid);
        assert.equal(searchMemories(manager, 'marker').length, 0);
        assert.equal(searchMemories(manager, 'preserved').length, 1);
        db.exec("INSERT INTO memory_fts(memory_fts, rank) VALUES ('integrity-check', 1)");
      } finally { manager.close(); fs.rmSync(root, { recursive: true, force: true }); }
    });
  }
});
