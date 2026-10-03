import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { indexSession, indexLiveSession } from '../../src/store/session-indexer.js';
import { searchSessionEvidence, searchSessions } from '../../src/store/session-search.js';
import { runSessionSearch } from '../../src/store/session-search-async.js';

function createCanonicalFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-owned-window-'));
  const manager = new DatabaseManager(root);
  const file = path.join(root, 'canonical.jsonl');
  const id = 'canonical-session';
  const timestamp = '2026-08-01T00:00:00Z';
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session', id, cwd: '/work/owned', project: 'owned', timestamp }),
    JSON.stringify({ type: 'message', id: 'canonical-entry', timestamp, message: { role: 'user', content: 'owned needle' } }),
  ].join('\n') + '\n');
  indexLiveSession(manager, { getHeader: () => ({ id, cwd: '/work/owned', timestamp }), getEntries: () => [], getSessionFile: () => file });
  indexSession(manager, {
    id: 'ownerless-session', project: 'owned', cwd: '/work/owned', startedAt: '2026-09-30T00:00:00Z', endedAt: null,
    messages: Array.from({ length: 20 }, (_, i) => ({ id: `ownerless-${i}`, role: 'user', content: 'owned needle', timestamp: '2026-09-30T00:00:00Z' })),
  });
  return { root, manager, id };
}

test('structured scoped search does not let ownerless rows hide a canonical hit', () => {
  const { root, manager, id } = createCanonicalFixture();
  try {
    const outcome = searchSessionEvidence(manager, 'needle', { sessionsDir: root, project: 'owned', limit: 1 });
    assert.equal(outcome.results.length, 1);
    assert.equal(outcome.results[0].sessionId, id);
    assert.equal(outcome.results[0].entryId, 'canonical-entry');
  } finally {
    manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('structured scoped search rejects stale owners that exhaust the bounded window', () => {
  const { root, manager } = createCanonicalFixture();
  try {
    manager.getDb().prepare(
      'INSERT INTO session_files (path, session_id, size, mtime_ms, indexed_at) VALUES (?, ?, ?, ?, ?)',
    ).run(path.join(root, 'missing.jsonl'), 'ownerless-session', 1, 1, new Date().toISOString());
    assert.throws(
      () => searchSessionEvidence(manager, 'needle', { sessionsDir: root, project: 'owned', limit: 1 }),
      error => error instanceof Error && error.name === 'SessionSearchReadLimitError',
    );
  } finally {
    manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy scoped search rejects removed stale owners instead of hiding a canonical hit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-stale-window-'));
  const manager = new DatabaseManager(root);
  const canonicalId = 'canonical-session';
  const canonicalFile = path.join(root, 'canonical.jsonl');
  fs.writeFileSync(canonicalFile, [
    JSON.stringify({ type: 'session', id: canonicalId, cwd: '/work/owned', project: 'owned', timestamp: '2026-08-01T00:00:00Z' }),
    JSON.stringify({ type: 'message', id: 'canonical-entry', timestamp: '2026-08-01T00:00:00Z', message: { role: 'user', content: 'owned needle' } }),
  ].join('\n') + '\n');
  const staleFiles: string[] = [];
  try {
    indexLiveSession(manager, { getHeader: () => ({ id: canonicalId, cwd: '/work/owned', timestamp: '2026-08-01T00:00:00Z' }), getEntries: () => [], getSessionFile: () => canonicalFile }, root);
    for (let i = 0; i < 20; i++) {
      const id = `stale-session-${i}`;
      const file = path.join(root, `${id}.jsonl`);
      staleFiles.push(file);
      fs.writeFileSync(file, [
        JSON.stringify({ type: 'session', id, cwd: '/work/owned', project: 'owned', timestamp: '2026-09-30T00:00:00Z' }),
        JSON.stringify({ type: 'message', id: `stale-entry-${i}`, timestamp: '2026-09-30T00:00:00Z', message: { role: 'user', content: 'owned needle' } }),
      ].join('\n') + '\n');
      indexLiveSession(manager, { getHeader: () => ({ id, cwd: '/work/owned', timestamp: '2026-09-30T00:00:00Z' }), getEntries: () => [], getSessionFile: () => file }, root);
    }
    for (const file of staleFiles) fs.rmSync(file);

    assert.throws(
      () => searchSessions(manager, 'needle', { sessionsDir: root, limit: 1 }),
      error => error instanceof Error && error.name === 'SessionSearchReadLimitError',
    );

    await assert.rejects(
      runSessionSearch({ mode: 'legacy', dbPath: manager.getPath(), query: 'needle', options: { sessionsDir: root, limit: 1 } }),
      error => error instanceof Error && error.name === 'SessionSearchReadLimitError',
    );

    await assert.rejects(
      runSessionSearch({ mode: 'structured', dbPath: manager.getPath(), query: 'needle', options: { sessionsDir: root, limit: 1 } }),
      error => error instanceof Error && error.name === 'SessionSearchReadLimitError',
    );
  } finally {
    manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
