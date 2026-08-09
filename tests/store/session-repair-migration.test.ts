import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager, SessionEvidenceUnavailableError } from '../../src/store/db.js';
import {
  runSessionRepairToCompletion,
  scheduleSessionRepairMigration,
  waitForSessionRepairMigration,
  type SessionRepairMigrationState,
} from '../../src/handlers/session-repair-migration.js';
import { searchSessionEvidence } from '../../src/store/session-search.js';

function makeLegacyDb(messageCount = 4): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-repair-'));
  const db = new Database(path.join(dir, 'sessions.db'));
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT NOT NULL, cwd TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, message_count INTEGER);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT, tool_calls TEXT);
    INSERT INTO sessions VALUES ('s', 'project', '/project', '2026-01-01', NULL, ${messageCount});
  `);
  for (let i = 0; i < messageCount; i += 1) {
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(`m${i}`, 's', i % 2 ? 'assistant' : 'user', `repair needle ${i}`, '2026-01-01', null);
  }
  db.close();
  return dir;
}

async function finish(manager: DatabaseManager): Promise<void> {
  const state = await runSessionRepairToCompletion(manager, { chunkSize: 2 });
  assert.equal(state.status, 'complete');
}

describe('strict advised-fresh session repair', () => {
  it('keeps first open bounded and fails evidence closed while pending', () => {
    const dir = makeLegacyDb();
    const manager = new DatabaseManager(dir);
    const state = manager.getSessionRepairState();
    assert.equal(state?.status, 'pending');
    assert.throws(() => searchSessionEvidence(manager, 'repair'), SessionEvidenceUnavailableError);
    manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists cursor, aborts safely, resumes idempotently and flips availability only on completion', async () => {
    const dir = makeLegacyDb();
    const manager = new DatabaseManager(dir);
    const aborted = new AbortController();
    aborted.abort();
    assert.equal((await manager.runSessionRepairChunk({ signal: aborted.signal }))?.status, 'aborted');
    assert.throws(() => searchSessionEvidence(manager, 'repair'), SessionEvidenceUnavailableError);
    await finish(manager);
    assert.equal(manager.getSessionRepairState()?.status, 'complete');
    assert.doesNotThrow(() => manager.getDb().prepare("SELECT 1 FROM messages WHERE id LIKE 'idx:v1:%'").get());
    manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps event-loop heartbeat gaps bounded while a large repair completes', async () => {
    const dir = makeLegacyDb(2_500);
    const manager = new DatabaseManager(dir);
    const gaps: number[] = [];
    let last = Date.now();
    const heartbeat = setInterval(() => {
      const now = Date.now();
      gaps.push(now - last);
      last = now;
    }, 2);
    const marker = new Promise<number>((resolve) => setTimeout(() => resolve(Date.now()), 5));
    const markerStarted = Date.now();
    const state = await runSessionRepairToCompletion(manager, {
      chunkSize: 128,
      wallClockBudgetMs: 20,
    });
    const markerAt = await marker;
    clearInterval(heartbeat);
    assert.equal(state.status, 'complete');
    assert.ok(markerAt - markerStarted < 100, `post-render marker delayed ${markerAt - markerStarted}ms`);
    assert.ok(Math.max(...gaps) < 100, `event-loop heartbeat gap ${Math.max(...gaps)}ms`);
    assert.equal((manager.getDb().prepare("SELECT COUNT(*) AS count FROM message_fts WHERE message_fts MATCH 'needle'").get() as { count: number }).count, 2_500);
    manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resets state when cancelled before the initial timer and allows rescheduling without DB activity', async () => {
    const dir = makeLegacyDb();
    const manager = new DatabaseManager(dir);
    const state: SessionRepairMigrationState = { inProgress: false, promise: null };
    let calls = 0;
    const original = manager.runSessionRepairChunk.bind(manager);
    manager.runSessionRepairChunk = (async (...args: Parameters<typeof original>) => {
      calls += 1;
      return original(...args);
    }) as typeof manager.runSessionRepairChunk;

    assert.equal(scheduleSessionRepairMigration(manager, state), true);
    state.cancel?.();
    assert.equal(await waitForSessionRepairMigration(25, state), true);
    assert.equal(state.inProgress, false);
    assert.equal(state.promise, null);
    assert.equal(state.abortController, undefined);
    assert.equal(state.cancel, undefined);
    assert.equal(calls, 0);

    assert.equal(scheduleSessionRepairMigration(manager, state), true);
    state.cancel?.();
    assert.equal(await waitForSessionRepairMigration(25, state), true);
    assert.equal(calls, 0);
    manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('allows only one process-equivalent chunk owner and completes after the loser resumes', async () => {
    const dir = makeLegacyDb();
    const first = new DatabaseManager(dir);
    const second = new DatabaseManager(dir);
    const [a, b] = await Promise.all([
      first.runSessionRepairChunk({ chunkSize: 2 }),
      second.runSessionRepairChunk({ chunkSize: 2 }),
    ]);
    assert.equal([a?.processed, b?.processed].filter((value) => value === 2).length, 1);
    await finish(first);
    assert.equal(first.getSessionRepairState()?.status, 'complete');
    second.close();
    first.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
