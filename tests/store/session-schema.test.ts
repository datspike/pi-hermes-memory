import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';

async function finishRepair(manager: DatabaseManager): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const state = await manager.runSessionRepairChunk({ chunkSize: 50 });
    if (state?.status === 'complete') return;
  }
  assert.fail('repair did not complete');
}

describe('logical entry schema migration', () => {
  it('repairs legacy IDs, ordinals and FTS mapping idempotently', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-'));
    const dbPath = path.join(dir, 'sessions.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT NOT NULL, cwd TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, message_count INTEGER DEFAULT 0);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL, tool_calls TEXT);
      INSERT INTO sessions VALUES ('s1', 'demo', '/work/demo', '2026-08-09T00:00:00Z', NULL, 2);
      INSERT INTO messages VALUES ('same', 's1', 'user', 'one', '2026-08-09T00:01:00Z', NULL);
      INSERT INTO messages VALUES ('other', 's1', 'assistant', 'two', '2026-08-09T00:02:00Z', NULL);
    `);
    legacy.close();
    const manager = new DatabaseManager(dir);
    const db = manager.getDb();
    await finishRepair(manager);
    const columns = (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((row) => row.name);
    for (const column of ['entry_id', 'kind', 'parent_entry_id', 'ordinal', 'tool_name', 'diagnostics']) assert.ok(columns.includes(column));
    const rows = db.prepare('SELECT id, entry_id, ordinal FROM messages ORDER BY ordinal').all() as Array<{ id: string; entry_id: string; ordinal: number }>;
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.id.startsWith('idx:v1:')));
    assert.deepEqual(rows.map((row) => row.entry_id), ['same', 'other']);
    assert.deepEqual(rows.map((row) => row.ordinal), [0, 1]);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM message_fts WHERE message_fts MATCH 'one OR two'").get() as { count: number }).count, 2);
    manager.close();
    const reopened = new DatabaseManager(dir);
    const reopenedRows = reopened.getDb().prepare('SELECT id, entry_id, ordinal FROM messages ORDER BY ordinal').all();
    assert.deepEqual(reopenedRows, rows);
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails closed before migration when unknown durable state exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-'));
    const manager = new DatabaseManager(dir);
    manager.getDb().exec('CREATE TABLE durable_future_state (value TEXT NOT NULL)');
    manager.close();
    assert.throws(() => new DatabaseManager(dir).getDb(), /unknown durable table/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails closed for unknown durable FTS-looking tables', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-'));
    const manager = new DatabaseManager(dir);
    manager.getDb().exec('CREATE TABLE durable_future_fts (value TEXT NOT NULL)');
    manager.close();
    assert.throws(() => new DatabaseManager(dir).getDb(), /unknown durable table.*durable_future_fts/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not rerun versioned session repair on a healthy reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-'));
    const first = new DatabaseManager(dir);
    first.getDb().prepare('INSERT INTO sessions (id, project, cwd, started_at) VALUES (?, ?, ?, ?)').run('s1', 'p', '/p', '2026-01-01');
    first.getDb().prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)').run('m1', 's1', 'user', 'one', '2026-01-01');
    first.close();

    const prototype = DatabaseManager.prototype as any;
    const originalRepair = prototype.repairSessionEntries;
    const originalMessageFts = prototype.rebuildMessageFts;
    prototype.repairSessionEntries = () => { throw new Error('unexpected startup repair'); };
    prototype.rebuildMessageFts = () => { throw new Error('unexpected startup FTS rebuild'); };
    try {
      assert.doesNotThrow(() => new DatabaseManager(dir).getDb());
    } finally {
      prototype.repairSessionEntries = originalRepair;
      prototype.rebuildMessageFts = originalMessageFts;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows same native IDs across sessions but excludes same-session duplicates', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-'));
    const manager = new DatabaseManager(dir);
    const db = manager.getDb();
    db.prepare('INSERT INTO sessions (id, project, cwd, started_at) VALUES (?, ?, ?, ?)').run('a', 'p', '/p', '2026-01-01');
    db.prepare('INSERT INTO sessions (id, project, cwd, started_at) VALUES (?, ?, ?, ?)').run('b', 'p', '/p', '2026-01-01');
    db.prepare('INSERT INTO messages (id, session_id, entry_id, role, content, timestamp, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?)').run('idx:v1:a1', 'a', 'native', 'user', 'a', '2026-01-01', 1);
    db.prepare('INSERT INTO messages (id, session_id, entry_id, role, content, timestamp, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?)').run('idx:v1:b1', 'b', 'native', 'user', 'b', '2026-01-01', 1);
    assert.throws(() => db.prepare('INSERT INTO messages (id, session_id, entry_id, role, content, timestamp, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?)').run('idx:v1:a2', 'a', 'native', 'user', 'duplicate', '2026-01-01', 2), /UNIQUE/);
    manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
