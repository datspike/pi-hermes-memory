import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseManager } from '../../src/store/db.js';
import { indexLiveSession } from '../../src/store/session-indexer.js';
import { searchSessionEvidence, searchSessions } from '../../src/store/session-search.js';

const QUERY = 'benchmark-needle';
const SESSION_ID = 'benchmark-cache-session';
const CALLS = 3;
const MESSAGE_COUNT = 200;
const MESSAGE_BYTES = 200_000;

function createBenchmarkFile(file: string): void {
  const payload = `${QUERY} ${'x'.repeat(MESSAGE_BYTES - QUERY.length - 1)}`;
  const lines = [JSON.stringify({ type: 'session', id: SESSION_ID, cwd: '/benchmark', timestamp: '2026-05-03T00:00:00Z' })];
  for (let index = 0; index < MESSAGE_COUNT; index++) {
    lines.push(JSON.stringify({
      type: 'message',
      id: `${SESSION_ID}-entry-${index}`,
      timestamp: `2026-05-03T00:01:${String(index % 60).padStart(2, '0')}Z`,
      message: { role: 'user', content: payload },
    }));
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

function candidateStats(dbManager: DatabaseManager): { candidateRows: number; uniqueSessionIds: number } {
  const db = dbManager.getDb();
  const rows = db.prepare('SELECT m.session_id FROM messages m WHERE m.rowid IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ?) LIMIT ?').all(`"${QUERY}"`, 200) as Array<{ session_id: string }>;
  return { candidateRows: rows.length, uniqueSessionIds: new Set(rows.map(row => row.session_id)).size };
}

function runCalls<T>(file: string, callback: () => T): { durationsMs: number[]; reads: number; results: number[] } {
  const originalReadFileSync = fs.readFileSync;
  let reads = 0;
  const durationsMs: number[] = [];
  const results: number[] = [];
  (fs as any).readFileSync = (...args: any[]) => {
    if (typeof args[0] === 'string' && path.resolve(args[0]) === path.resolve(file)) reads++;
    return (originalReadFileSync as any)(...args);
  };
  try {
    for (let index = 0; index < CALLS; index++) {
      const started = performance.now();
      const result = callback();
      durationsMs.push(Math.round((performance.now() - started) * 100) / 100);
      results.push(Array.isArray(result) ? result.length : (result as { results: unknown[] }).results.length);
    }
  } finally {
    (fs as any).readFileSync = originalReadFileSync;
  }
  return { durationsMs, reads, results };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-search-cache-bench-'));
const file = path.join(tmpDir, `${SESSION_ID}.jsonl`);
const dbManager = new DatabaseManager(tmpDir);
try {
  createBenchmarkFile(file);
  indexLiveSession(dbManager, {
    getHeader: () => ({ id: SESSION_ID, cwd: '/benchmark', timestamp: '2026-05-03T00:00:00Z' }),
    getEntries: () => [],
    getSessionFile: () => file,
  });

  const stats = candidateStats(dbManager);
  const legacy = runCalls(file, () => searchSessions(dbManager, QUERY, { limit: 10, sessionsDir: tmpDir }));
  const structured = runCalls(file, () => searchSessionEvidence(dbManager, QUERY, { limit: 10, sessionsDir: tmpDir }));

  console.log(JSON.stringify({
    fileBytes: fs.statSync(file).size,
    candidateRows: stats.candidateRows,
    uniqueSessionIds: stats.uniqueSessionIds,
    calls: CALLS,
    legacy,
    structured,
  }, null, 2));
} finally {
  dbManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
