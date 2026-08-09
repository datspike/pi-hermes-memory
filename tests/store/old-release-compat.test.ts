import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { parseSessionFile } from '../../src/store/session-parser.js';
import { indexSession } from '../../src/store/session-indexer.js';
import { searchSessionEvidence } from '../../src/store/session-search.js';

async function finishRepair(manager: DatabaseManager): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const state = await manager.runSessionRepairChunk({ chunkSize: 50 });
    if (state?.status === 'complete') return;
  }
  assert.fail('legacy repair did not complete');
}

function legacyDb(dir: string): void {
  const db = new Database(path.join(dir, 'sessions.db'));
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT NOT NULL, cwd TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, message_count INTEGER DEFAULT 0, name TEXT, title TEXT);
    CREATE TABLE session_files (path TEXT PRIMARY KEY, session_id TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, indexed_at TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL, tool_calls TEXT, entry_id TEXT, kind TEXT DEFAULT 'text', ordinal INTEGER DEFAULT 0, parent_id TEXT, tool_name TEXT, tool_call_id TEXT);
    CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, target TEXT NOT NULL, category TEXT, content TEXT NOT NULL, failure_reason TEXT, tool_state TEXT, corrected_to TEXT, evidence_session_id TEXT, evidence_entry_id TEXT, evidence_anchor TEXT, evidence_timestamp TEXT, created DATE NOT NULL, last_referenced DATE NOT NULL);
    INSERT INTO sessions VALUES ('s', 'p', '/p', '2026-08-09T00:00:00Z', NULL, 2, NULL, NULL);
    INSERT INTO messages VALUES ('m1', 's', 'user', 'parent compatibility', '2026-08-09T00:00:01Z', NULL, 'm1', 'text', 0, NULL, NULL, NULL);
    INSERT INTO messages VALUES ('m2', 's', 'assistant', 'tool output', '2026-08-09T00:00:02Z', NULL, 'm2', 'tool_call', 1, 'm1', 'compat', 'call-1');
    INSERT INTO memories (project,target,content,created,last_referenced) VALUES ('p', 'memory', 'empty evidence', '2026-08-09', '2026-08-09');
    CREATE VIRTUAL TABLE message_fts USING fts5(content, content='messages', content_rowid='rowid');
    CREATE VIRTUAL TABLE memory_fts USING fts5(content, content='memories', content_rowid='id');
    CREATE INDEX idx_legacy_content ON messages(content);
  `);
  db.close();
}

describe('PH-008 old-release compatibility', () => {
  it('opens the exact legacy inventory, repairs parent_id idempotently, and preserves tool_call_id', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph008-compat-'));
    legacyDb(dir);
    const manager = new DatabaseManager(dir);
    const db = manager.getDb();
    await finishRepair(manager);
    assert.equal(db.prepare("SELECT parent_entry_id FROM messages WHERE entry_id = 'm2'").get()?.parent_entry_id, 'm1');
    assert.equal(db.prepare("SELECT tool_call_id FROM messages WHERE entry_id = 'm2'").get()?.tool_call_id, 'call-1');
    manager.close();
    const reopened = new DatabaseManager(dir);
    assert.equal(reopened.getDb().prepare("SELECT parent_entry_id FROM messages WHERE entry_id = 'm2'").get()?.parent_entry_id, 'm1');
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('preserves canonical parent and appends a stable conflict diagnostic', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph008-conflict-'));
    const manager = new DatabaseManager(dir);
    const db = manager.getDb();
    db.prepare("INSERT INTO sessions (id, project, cwd, started_at) VALUES ('s', 'p', '/p', '2026-08-09')").run();
    db.prepare("INSERT INTO messages (id, session_id, entry_id, role, content, timestamp, parent_entry_id) VALUES ('m', 's', 'm', 'user', 'x', '2026-08-09', 'canonical')").run();
    db.exec('ALTER TABLE messages ADD COLUMN parent_id TEXT');
    db.prepare("UPDATE messages SET parent_id = 'legacy'").run();
    db.exec('PRAGMA user_version = 0');
    db.prepare("DELETE FROM extension_metadata WHERE key = 'session_repair_state:v1'").run();
    manager.close();
    const reopened = new DatabaseManager(dir);
    await finishRepair(reopened);
    const row = reopened.getDb().prepare("SELECT parent_entry_id, diagnostics FROM messages WHERE entry_id = 'm'").get() as { parent_entry_id: string; diagnostics: string };
    assert.equal(row.parent_entry_id, 'canonical');
    assert.deepEqual(JSON.parse(row.diagnostics), ['legacy-parent-conflict']);
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('recovers legacy rows, repairs parent conflicts, strips evidence columns, and rebuilds FTS', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph008-recovery-'));
    legacyDb(dir);
    const seed = new Database(path.join(dir, 'sessions.db'));
    seed.exec('ALTER TABLE messages ADD COLUMN parent_entry_id TEXT');
    seed.prepare("UPDATE messages SET parent_entry_id = 'canonical-parent' WHERE entry_id = 'm2'").run();
    seed.close();
    const corrupt = new Database(path.join(dir, 'sessions.db'));
    const pageSize = corrupt.pragma('page_size', { simple: true }) as number;
    const page = corrupt.prepare("SELECT pageno FROM dbstat WHERE name = 'idx_legacy_content' LIMIT 1").get() as { pageno: number };
    corrupt.close();
    const bytes = fs.readFileSync(path.join(dir, 'sessions.db'));
    bytes[(page.pageno - 1) * pageSize] ^= 0xff;
    fs.writeFileSync(path.join(dir, 'sessions.db'), bytes);
    const manager = new DatabaseManager(dir);
    const recovery = manager.recoverFromCorruption(new Error('SQLITE_CORRUPT: recoverable index page'));
    assert.equal(recovery.strategy, 'rebuilt');
    assert.equal(recovery.status, 'healthy');
    const db = manager.getDb();
    const row = db.prepare("SELECT parent_entry_id, tool_call_id, diagnostics FROM messages WHERE entry_id = 'm2'").get() as { parent_entry_id: string; tool_call_id: string; diagnostics: string };
    assert.equal(row.parent_entry_id, 'canonical-parent');
    assert.equal(row.tool_call_id, 'call-1');
    assert.deepEqual(JSON.parse(row.diagnostics), ['legacy-parent-conflict']);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM message_fts WHERE message_fts MATCH 'compatibility'").get() as { n: number }).n, 1);
    const evidenceColumns = (db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>).map((entry) => entry.name).filter((name) => name.startsWith('evidence_'));
    assert.deepEqual(evidenceColumns, []);
    manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('captures tool-call IDs with old-release precedence and indexes them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph008-parser-'));
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 's', cwd: '/p', timestamp: '2026-08-09T00:00:00Z' }),
      JSON.stringify({ type: 'message', id: 'call', timestamp: '2026-08-09T00:00:01Z', message: { role: 'assistant', toolCallId: 'message-id', content: [{ type: 'tool_use', name: 'compat', id: 'block-id' }] } }),
      JSON.stringify({ type: 'message', id: 'block-only', timestamp: '2026-08-09T00:00:01Z', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'compat_block', toolCallId: 'block-only-id' }] } }),
      JSON.stringify({ type: 'message', id: 'result', timestamp: '2026-08-09T00:00:02Z', message: { role: 'toolResult', content: [{ type: 'tool_result', toolCallId: 'result-id', content: [{ type: 'text', text: 'result searchable' }] }] } }),
    ].join('\n'));
    const parsed = parseSessionFile(file);
    assert.ok(parsed);
    assert.equal(parsed.messages[0].toolCallId, 'message-id');
    assert.equal(parsed.messages[1].toolCallId, 'block-only-id');
    assert.equal(parsed.messages[2].toolCallId, 'result-id');
    const manager = new DatabaseManager(dir);
    indexSession(manager, parsed);
    const row = manager.getDb().prepare("SELECT tool_call_id FROM messages WHERE entry_id = 'call'").get() as { tool_call_id: string };
    const blockRow = manager.getDb().prepare("SELECT tool_call_id FROM messages WHERE entry_id = 'block-only'").get() as { tool_call_id: string };
    assert.equal(row.tool_call_id, 'message-id');
    assert.equal(blockRow.tool_call_id, 'block-only-id');
    manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tolerates NULL and empty evidence values but blocks whitespace, unknown columns, and tables', () => {
    for (const value of [null, '']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph008-empty-evidence-'));
      legacyDb(dir);
      const db = new Database(path.join(dir, 'sessions.db'));
      for (const column of ['evidence_session_id', 'evidence_entry_id', 'evidence_anchor', 'evidence_timestamp']) db.prepare(`UPDATE memories SET ${column} = ?`).run(value);
      db.close();
      const manager = new DatabaseManager(dir);
      manager.getDb();
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    for (const column of ['evidence_session_id', 'evidence_entry_id', 'evidence_anchor', 'evidence_timestamp']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph008-evidence-'));
      legacyDb(dir);
      const db = new Database(path.join(dir, 'sessions.db'));
      db.prepare(`UPDATE memories SET ${column} = ?`).run(' ');
      db.close();
      assert.throws(() => new DatabaseManager(dir).getDb(), /non-empty excluded provenance column/);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph008-unknown-'));
    legacyDb(dir);
    const db = new Database(path.join(dir, 'sessions.db'));
    db.exec('ALTER TABLE memories ADD COLUMN evidence_future TEXT');
    db.close();
    assert.throws(() => new DatabaseManager(dir).getDb(), /unknown durable column/);
    fs.rmSync(dir, { recursive: true, force: true });
    const tableDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph008-unknown-table-'));
    legacyDb(tableDir);
    const tableDb = new Database(path.join(tableDir, 'sessions.db'));
    tableDb.exec('CREATE TABLE evidence_future (value TEXT)');
    tableDb.close();
    assert.throws(() => new DatabaseManager(tableDir).getDb(), /unknown durable table/);
    fs.rmSync(tableDir, { recursive: true, force: true });
  });

  it('returns tool_call_id in structured search rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph008-search-'));
    const manager = new DatabaseManager(dir);
    const db = manager.getDb();
    db.prepare("INSERT INTO sessions (id, project, cwd, started_at) VALUES ('s', 'p', '/p', '2026-08-09')").run();
    db.prepare("INSERT INTO messages (id, session_id, entry_id, role, kind, content, timestamp, tool_name, tool_call_id) VALUES ('m', 's', 'm', 'assistant', 'message', 'compat searchable', '2026-08-09', 'compat', 'call-1')").run();
    const file = path.join(dir, 'canonical.jsonl');
    fs.writeFileSync(file, [JSON.stringify({ type: 'session', id: 's', cwd: '/p', timestamp: '2026-08-09' }), JSON.stringify({ type: 'message', id: 'm', timestamp: '2026-08-09', message: { role: 'assistant', toolCallId: 'call-1', content: 'compat searchable' } })].join('\n'));
    db.prepare("INSERT INTO session_files VALUES (?, 's', 1, 1, '2026-08-09')").run(file);
    const result = searchSessionEvidence(manager, 'compat', { includeToolOutput: true });
    assert.equal(result.results[0]?.tool_call_id, 'call-1');
    manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
