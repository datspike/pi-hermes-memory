import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { indexSession, indexLiveSession } from '../../src/store/session-indexer.js';
import { searchSessions, searchSessionEvidence } from '../../src/store/session-search.js';

test('legacy and structured search do not let ownerless records exhaust the canonical candidate allowance', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-search-'));
  const manager = new DatabaseManager(root);
  const file = path.join(root, 'canonical.jsonl');
  const id = 'canonical-session';
  const timestamp = '2026-08-01T00:00:00Z';
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session', id, cwd: '/work/owned', timestamp }),
    JSON.stringify({ type: 'message', id: 'canonical-entry', timestamp, message: { role: 'user', content: 'owned needle' } }),
  ].join('\n') + '\n');
  try {
    indexLiveSession(manager, { getHeader: () => ({ id, cwd: '/work/owned', timestamp }), getEntries: () => [], getSessionFile: () => file });
    indexSession(manager, {
      id: 'ownerless-session', project: 'owned', cwd: '/work/owned', startedAt: timestamp, endedAt: null,
      messages: Array.from({ length: 250 }, (_, i) => ({ id: `ownerless-${i}`, role: 'user', content: 'owned needle', timestamp: '2026-09-30T00:00:00Z' })),
    });
    const results = searchSessions(manager, 'needle', { sessionsDir: root, limit: 1 });
    assert.equal(results.length, 1);
    assert.equal(results[0].sessionId, id);
    assert.equal(searchSessions(manager, 'needle', { limit: 1 })[0].sessionId, 'ownerless-session', 'legacy callers without a canonical root keep their original indexed-only contract');
    // Structured search excludes ownerless rows before its bounded canonical window.
    const structured = searchSessionEvidence(manager, 'needle', { sessionsDir: root, limit: 1 });
    assert.equal(structured.results.length, 1);
    assert.equal(structured.results[0].sessionId, id);
  } finally { manager.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
