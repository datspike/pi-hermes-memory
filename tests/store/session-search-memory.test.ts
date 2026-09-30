import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseManager } from '../../src/store/db.js';
import { indexSession, upsertSessionFileMetadata } from '../../src/store/session-indexer.js';

/** Exercise the public search API below the memory needed by full candidate payloads. */
function searchInSmallHeap(memoryDir: string, source: string, heapMb = 96): unknown {
  const child = spawnSync('bash', ['-c', 'ulimit -c 0; exec "$@"', 'search-memory-test',
    process.execPath, `--max-old-space-size=${heapMb}`, '--import', 'tsx', '--input-type=module', '-e', `
      import Database from 'better-sqlite3';
      import { searchSessions, searchSessionEvidence } from './src/store/session-search.ts';
      const db = new Database(${JSON.stringify(path.join(memoryDir, 'sessions.db'))}, { readonly: true });
      db.pragma('query_only=ON');
      const manager = { getDb: () => db, assertSessionEvidenceAvailable() {} };
      ${source}
      db.close();
    `], { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, `Search failed (${child.signal}): ${child.stderr}`);
  return JSON.parse(child.stdout.trim());
}

describe('session search memory bounds', () => {
  it('finds canonical results without loading oversized unowned candidate payloads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-memory-'));
    const manager = new DatabaseManager(dir);
    try {
      const payload = `${'я'.repeat(1024 * 1024)} needle`;
      for (let index = 0; index < 40; index++) {
        indexSession(manager, {
          id: `unowned-${index}`, project: 'memory-test', cwd: '/memory-test',
          startedAt: '2026-05-03T00:00:00Z', endedAt: null,
          messages: [{ id: `entry-${index}`, role: 'user', content: payload, timestamp: '2026-05-03T00:02:00Z' }],
        });
      }
      const file = path.join(dir, 'canonical.jsonl');
      fs.writeFileSync(file, [
        JSON.stringify({ type: 'session', id: 'canonical', cwd: '/memory-test', timestamp: '2026-05-03T00:00:00Z' }),
        JSON.stringify({ type: 'message', id: 'wanted', timestamp: '2026-05-03T00:01:00Z', message: { role: 'user', content: 'canonical needle' } }),
      ].join('\n') + '\n');
      indexSession(manager, {
        id: 'canonical', project: 'memory-test', cwd: '/memory-test',
        startedAt: '2026-05-03T00:00:00Z', endedAt: null,
        messages: [{ id: 'wanted', role: 'user', content: 'canonical needle', timestamp: '2026-05-03T00:01:00Z' }],
      });
      upsertSessionFileMetadata(manager, file, 'canonical');
      manager.close();
      const results = searchInSmallHeap(dir, `
        const options = { limit: 8, role: 'user', sessionsDir: ${JSON.stringify(dir)} };
        const legacy = searchSessions(manager, 'needle', options);
        const structured = searchSessionEvidence(manager, 'needle', options).results;
        console.log(JSON.stringify({ legacy: legacy.map(row => row.snippet), structured: structured.map(row => row.snippet) }));
      `);
      assert.deepEqual(results, { legacy: ['canonical needle'], structured: ['canonical needle'] });
    } finally {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validates large canonical transcripts without retaining unrelated message bodies', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-transcript-memory-'));
    const manager = new DatabaseManager(dir);
    try {
      const file = path.join(dir, 'large.jsonl');
      fs.writeFileSync(file, JSON.stringify({ type: 'session', id: 'large', cwd: '/memory-test', timestamp: '2026-05-03T00:00:00Z' }) + '\n');
      const payload = 'я'.repeat(8192);
      const fd = fs.openSync(file, 'a');
      try {
        for (let index = 0; index < 4000; index++) {
          fs.writeSync(fd, JSON.stringify({ type: 'message', id: `unrelated-${index}`, timestamp: '2026-05-03T00:00:30Z', message: { role: 'assistant', content: payload } }) + '\n');
        }
        fs.writeSync(fd, JSON.stringify({ type: 'message', id: 'wanted', timestamp: '2026-05-03T00:01:00Z', message: { role: 'user', content: 'canonical needle near EOF' } }) + '\n');
      } finally { fs.closeSync(fd); }
      indexSession(manager, {
        id: 'large', project: 'memory-test', cwd: '/memory-test',
        startedAt: '2026-05-03T00:00:00Z', endedAt: null,
        messages: [{ id: 'wanted', role: 'user', content: 'canonical needle near EOF', timestamp: '2026-05-03T00:01:00Z' }],
      });
      upsertSessionFileMetadata(manager, file, 'large');
      manager.close();
      const results = searchInSmallHeap(dir, `
        const options = { limit: 8, sessionsDir: ${JSON.stringify(dir)} };
        const legacy = searchSessions(manager, 'needle', options);
        const structured = searchSessionEvidence(manager, 'needle', options).results;
        console.log(JSON.stringify({ legacy: legacy.map(row => row.snippet), structured: structured.map(row => row.snippet) }));
      `);
      assert.deepEqual(results, { legacy: ['canonical needle near EOF'], structured: ['canonical needle near EOF'] });
    } finally {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
