import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseManager } from '../../src/store/db.js';
import { indexLiveSession, indexSession } from '../../src/store/session-indexer.js';
import { searchSessionEvidence, searchSessions, getIndexedMessageCount } from '../../src/store/session-search.js';
import type { ParsedSession } from '../../src/store/session-parser.js';

describe('session-search', () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-test-'));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTestSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
    const id = overrides.id ?? 'session-1';
    return {
      id,
      project: 'test-project',
      cwd: '/test',
      startedAt: '2026-05-03T00:00:00Z',
      endedAt: null,
      messages: [
        { id: `${id}-msg-1`, role: 'user', content: 'How do I set up Prisma with PostgreSQL?', timestamp: '2026-05-03T00:01:00Z' },
        { id: `${id}-msg-2`, role: 'assistant', content: 'To set up Prisma, install the package and run prisma init. Then configure your DATABASE_URL in .env', timestamp: '2026-05-03T00:01:30Z' },
        { id: `${id}-msg-3`, role: 'user', content: 'What about database migrations?', timestamp: '2026-05-03T00:02:00Z' },
        { id: `${id}-msg-4`, role: 'assistant', content: 'Use prisma migrate dev to create migrations. This generates SQL files and applies them.', timestamp: '2026-05-03T00:02:30Z' },
        { id: `${id}-msg-5`, role: 'user', content: 'What about gpu timeout issue debugging?', timestamp: '2026-05-03T00:03:00Z' },
        { id: `${id}-msg-6`, role: 'assistant', content: 'This exact phrase memory search example helps verify phrase queries.', timestamp: '2026-05-03T00:03:30Z' },
      ],
      ...overrides,
    };
  }

  describe('searchSessions', () => {
    it('should find messages matching a search query', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'Prisma');
      assert.ok(results.length > 0);
      assert.ok(results.some(r => r.content.includes('Prisma')));
    });

    it('should return results with snippets', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'migrations');
      assert.ok(results.length > 0);
      assert.ok(results[0].snippet.length > 0);
    });

    it('should return results with session metadata', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'Prisma');
      assert.ok(results.length > 0);
      assert.strictEqual(results[0].sessionId, 'session-1');
      assert.strictEqual(results[0].project, 'test-project');
      assert.ok(results[0].timestamp.length > 0);
    });

    it('should limit results', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'Prisma', { limit: 1 });
      assert.strictEqual(results.length, 1);
    });

    it('should filter by role', () => {
      indexSession(dbManager, createTestSession());

      const userResults = searchSessions(dbManager, 'Prisma', { role: 'user' });
      const assistantResults = searchSessions(dbManager, 'Prisma', { role: 'assistant' });

      // User asked about Prisma, assistant answered about Prisma
      assert.ok(userResults.length > 0);
      assert.ok(assistantResults.length > 0);
      assert.ok(userResults.every(r => r.role === 'user'));
      assert.ok(assistantResults.every(r => r.role === 'assistant'));
    });

    it('should filter by project', () => {
      indexSession(dbManager, createTestSession({ id: 's1', project: 'project-a' }));
      indexSession(dbManager, createTestSession({ id: 's2', project: 'project-b', messages: [
        { id: 's2-m1', role: 'user', content: 'Different topic entirely', timestamp: '2026-05-03T00:01:00Z' },
      ] }));

      const results = searchSessions(dbManager, 'Prisma', { project: 'project-a' });
      assert.ok(results.length > 0);
      assert.ok(results.every(r => r.project === 'project-a'));
    });

    it('should return empty for no matches', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'nonexistent-topic-xyz');
      assert.strictEqual(results.length, 0);
    });

    it('should return empty for empty database', () => {
      const results = searchSessions(dbManager, 'anything');
      assert.strictEqual(results.length, 0);
    });

    it('should match multi-word queries without requiring an exact phrase', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'gpu issue');
      assert.ok(results.length > 0);
      assert.ok(results.some((r) => r.content.includes('gpu timeout issue')));
    });

    it('should ignore lowercase connector words in natural-language queries', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'gpu and issue');
      assert.ok(results.length > 0);
      assert.ok(results.some((r) => r.content.includes('gpu timeout issue')));
    });

    it('should preserve explicit quoted phrase searches', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, '"memory search"');
      assert.ok(results.length > 0);
      assert.ok(results.every((r) => r.content.includes('memory search')));
    });

    it('should recover natural-language queries with uppercase operator words and punctuation', () => {
      indexSession(dbManager, createTestSession({ id: 'recovery-session', messages: [
        { id: 'recovery-session-msg-1', role: 'assistant', content: 'Never search whole filesystem from root. Do not run find /.', timestamp: '2026-05-03T00:01:00Z' },
      ] }));

      const results = searchSessions(dbManager, 'DO NOT USE FIND /');

      assert.ok(results.length > 0);
      assert.ok(results.some((r) => r.content.includes('find')));
    });

    it('should preserve valid operator queries', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'Prisma OR gpu');
      assert.ok(results.length >= 2);
      assert.ok(results.some((r) => r.content.includes('Prisma')));
      assert.ok(results.some((r) => r.content.includes('gpu timeout issue')));
    });

    it('should fall back to broader natural-language FTS matching when strict term matching misses', () => {
      indexSession(dbManager, createTestSession({ id: 'fallback-session', messages: [
        { id: 'fallback-session-msg-1', role: 'assistant', content: "The user's name is Naruto", timestamp: '2026-05-03T00:01:00Z' },
      ] }));

      const results = searchSessions(dbManager, 'name identity Naruto');

      assert.ok(results.length > 0);
      assert.ok(results.some((r) => r.content.includes('Naruto')));
    });

    it('should find mixed Chinese/English queries via fallback', () => {
      indexSession(dbManager, createTestSession({ id: 'mixed-cjk-session', messages: [
        { id: 'mixed-cjk-session-msg-1', role: 'assistant', content: 'codex 已经开始执行探索任务了', timestamp: '2026-05-03T00:01:00Z' },
      ] }));

      const results = searchSessions(dbManager, 'codex 执行 任务');

      assert.ok(results.length > 0);
      assert.ok(results.some((r) => r.content.includes('codex 已经开始执行探索任务了')));
    });

    it('should find Chinese-only substrings via LIKE fallback', () => {
      indexSession(dbManager, createTestSession({ id: 'cjk-only-session', messages: [
        { id: 'cjk-only-session-msg-1', role: 'assistant', content: '已经开始执行探索任务了', timestamp: '2026-05-03T00:01:00Z' },
      ] }));

      const results = searchSessions(dbManager, '执行');

      assert.ok(results.length > 0);
      assert.ok(results.some((r) => r.content.includes('已经开始执行探索任务了')));
    });

    it('should preserve filters, ordering, and limit during LIKE fallback', () => {
      indexSession(dbManager, createTestSession({ id: 'cjk-filter-a', project: 'project-a', messages: [
        { id: 'cjk-filter-a-msg-1', role: 'user', content: '早期已经开始执行探索任务了', timestamp: '2026-05-03T00:01:00Z' },
        { id: 'cjk-filter-a-msg-2', role: 'user', content: '后续继续执行更多任务', timestamp: '2026-05-03T00:03:00Z' },
      ] }));
      indexSession(dbManager, createTestSession({ id: 'cjk-filter-b', project: 'project-b', messages: [
        { id: 'cjk-filter-b-msg-1', role: 'assistant', content: '另一个项目也执行任务', timestamp: '2026-05-03T00:04:00Z' },
      ] }));

      const results = searchSessions(dbManager, '执行', {
        project: 'project-a',
        role: 'user',
        since: '2026-05-03T00:02:00Z',
        limit: 1,
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].project, 'project-a');
      assert.strictEqual(results[0].role, 'user');
      assert.strictEqual(results[0].timestamp, '2026-05-03T00:03:00Z');
      assert.ok(results[0].content.includes('后续继续执行更多任务'));
    });

    it('should escape LIKE wildcard characters during fallback', () => {
      indexSession(dbManager, createTestSession({ id: 'like-escape-session', messages: [
        { id: 'like-escape-session-msg-1', role: 'user', content: 'Progress reached 100% today', timestamp: '2026-05-03T00:01:00Z' },
        { id: 'like-escape-session-msg-2', role: 'user', content: 'A plain message without the wildcard character', timestamp: '2026-05-03T00:02:00Z' },
      ] }));

      const results = searchSessions(dbManager, '%');

      assert.ok(results.length > 0);
      assert.ok(results.every((r) => r.content.includes('%')));
    });

    it('should not broaden explicit operator queries', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'Prisma AND nonexistent');

      assert.strictEqual(results.length, 0);
    });

    it('should handle malformed FTS5 queries gracefully', () => {
      indexSession(dbManager, createTestSession());

      // Malformed FTS5 query should not throw
      const results = searchSessions(dbManager, 'AND OR NOT');
      assert.ok(Array.isArray(results));
    });

    it('should handle unmatched quotes gracefully', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'issue "timeout');
      assert.ok(Array.isArray(results));
    });

    it('should return empty for blank queries', () => {
      assert.deepStrictEqual(searchSessions(dbManager, '   '), []);
    });

    it('validates one canonical JSONL once per session across legacy and structured candidates', () => {
      const id = 'dedupe-session';
      const file = path.join(tmpDir, `${id}.jsonl`);
      fs.writeFileSync(file, [
        JSON.stringify({ type: 'session', id, cwd: '/dedupe', timestamp: '2026-05-03T00:00:00Z' }),
        ...Array.from({ length: 40 }, (_, index) => JSON.stringify({ type: 'message', id: `${id}-entry-${index}`, timestamp: `2026-05-03T00:01:${String(index).padStart(2, '0')}Z`, message: { role: 'user', content: 'dedupe needle' } })),
      ].join('\n') + '\n');
      indexLiveSession(dbManager, { getHeader: () => ({ id, cwd: '/dedupe', timestamp: '2026-05-03T00:00:00Z' }), getEntries: () => [], getSessionFile: () => file });
      const originalOpenSync = fs.openSync;
      let reads = 0;
      (fs as any).openSync = (...args: any[]) => {
        if (typeof args[0] === 'string' && path.resolve(args[0]) === path.resolve(file)) reads++;
        return (originalOpenSync as any)(...args);
      };
      try {
        const legacy = searchSessions(dbManager, 'needle', { limit: 10, sessionsDir: tmpDir });
        assert.strictEqual(legacy.length, 10);
        assert.strictEqual(reads, 1);

        reads = 0;
        const structured = searchSessionEvidence(dbManager, 'needle', { limit: 10, sessionsDir: tmpDir });
        assert.strictEqual(structured.results.length, 3);
        assert.strictEqual(reads, 1);
      } finally {
        (fs as any).openSync = originalOpenSync;
      }
    });
  });

  describe('searchSessionEvidence', () => {
    function canonicalFile(id: string, content: string, cwd = '/canonical/project'): string {
      const file = path.join(tmpDir, `${id}.jsonl`);
      fs.writeFileSync(file, [
        JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-05-03T00:00:00Z' }),
        JSON.stringify({ type: 'message', id: `${id}-entry`, timestamp: '2026-05-03T00:01:00Z', message: { role: 'user', content } }),
      ].join('\n') + '\n');
      return file;
    }

    it('returns full evidence identity, metadata, anchor and higher-is-better score', () => {
      const file = canonicalFile('evidence-session', 'canonical needle 😀');
      indexLiveSession(dbManager, { getHeader: () => ({ id: 'evidence-session', cwd: '/canonical/project', timestamp: '2026-05-03T00:00:00Z' }), getEntries: () => [], getSessionFile: () => file });
      const result = searchSessionEvidence(dbManager, 'needle');
      assert.strictEqual(result.results.length, 1);
      const hit = result.results[0];
      assert.strictEqual(hit.anchor, 'pi://session/evidence-session#entry=evidence-session-entry');
      assert.strictEqual(hit.entryId, 'evidence-session-entry');
      assert.strictEqual(hit.cwd, '/canonical/project');
      assert.strictEqual(hit.kind, 'message');
      assert.ok(Number.isFinite(hit.score));
      assert.ok(hit.scoreMode === 'bm25' || hit.scoreMode === 'like');
      assert.ok(hit.snippet.includes('needle'));
    });

    it('filters canonical eligibility before limit and only includes the exact current session by opt-in', () => {
      const lowerFile = canonicalFile('canonical-lower', 'needle');
      const currentFile = canonicalFile('current-session', 'needle needle');
      indexLiveSession(dbManager, { getHeader: () => ({ id: 'canonical-lower', cwd: '/canonical/project', timestamp: '2026-05-03T00:00:00Z' }), getEntries: () => [], getSessionFile: () => lowerFile });
      indexLiveSession(dbManager, { getHeader: () => ({ id: 'current-session', cwd: '/canonical/project', timestamp: '2026-05-03T00:00:00Z' }), getEntries: () => [], getSessionFile: () => currentFile });
      indexSession(dbManager, { id: 'live-top', project: 'live', cwd: '/live', startedAt: '2026-05-03T00:00:00Z', endedAt: null, messages: [{ id: 'live-entry', role: 'user', content: 'needle needle needle needle', timestamp: '2026-05-03T00:02:00Z' }] });
      const canonicalOnly = searchSessionEvidence(dbManager, 'needle', { limit: 1, currentSessionId: 'current-session' });
      assert.deepStrictEqual(canonicalOnly.results.map((hit) => hit.sessionId), ['canonical-lower']);
      const withCurrent = searchSessionEvidence(dbManager, 'needle', { sessionId: 'current-session', limit: 1, includeCurrentSession: true, currentSessionId: 'current-session' });
      assert.strictEqual(withCurrent.results.some((hit) => hit.sessionId === 'current-session'), true);
      const unrelated = searchSessionEvidence(dbManager, 'needle', { limit: 10, includeCurrentSession: true, currentSessionId: 'current-session' });
      assert.strictEqual(unrelated.results.some((hit) => hit.sessionId === 'live-top'), false);
    });

    it('rejects ambiguous prefixes and supports exact IDs plus project/role/since parity', () => {
      for (const id of ['prefix-one', 'prefix-two']) {
        const file = canonicalFile(id, 'needle', `/work/${id}`);
        indexLiveSession(dbManager, { getHeader: () => ({ id, cwd: `/work/${id}`, timestamp: '2026-05-03T00:00:00Z' }), getEntries: () => [], getSessionFile: () => file });
      }
      const ambiguous = searchSessionEvidence(dbManager, 'needle', { sessionId: 'prefix-' });
      assert.deepStrictEqual(ambiguous.results, []);
      assert.deepStrictEqual(ambiguous.ambiguousSessionIds, ['prefix-one', 'prefix-two']);
      const exact = searchSessionEvidence(dbManager, 'needle', { sessionId: 'prefix-one', project: 'prefix-one', role: 'user', since: '2026-05-03T00:00:00Z' });
      assert.strictEqual(exact.results.length, 1);
      assert.strictEqual(exact.results[0].sessionId, 'prefix-one');
    });

    it('keeps service metadata excluded, including consolidation names, while blank-cleared ordinary names remain searchable', () => {
      const serviceFile = canonicalFile('service-session', 'needle service', '/service');
      const ordinaryFile = canonicalFile('ordinary-session', 'needle ordinary', '/ordinary');
      indexLiveSession(dbManager, { getHeader: () => ({ id: 'service-session', cwd: '/service', timestamp: '2026-05-03T00:00:00Z' }), getEntries: () => [], getSessionFile: () => serviceFile });
      indexLiveSession(dbManager, { getHeader: () => ({ id: 'ordinary-session', cwd: '/ordinary', timestamp: '2026-05-03T00:00:00Z' }), getEntries: () => [], getSessionFile: () => ordinaryFile });
      dbManager.getDb().prepare('UPDATE sessions SET name = ? WHERE id = ?').run('consolidation service', 'service-session');
      dbManager.getDb().prepare('UPDATE sessions SET name = NULL WHERE id = ?').run('ordinary-session');
      const defaultResults = searchSessionEvidence(dbManager, 'needle');
      // Privacy classification is authoritative from the current JSONL; stale
      // SQLite-only session names must not hide or expose evidence.
      assert.strictEqual(defaultResults.results.some((hit) => hit.sessionId === 'service-session'), true);
      assert.strictEqual(defaultResults.results.some((hit) => hit.sessionId === 'ordinary-session'), true);
      assert.strictEqual(searchSessionEvidence(dbManager, 'needle', { includeService: true }).results.some((hit) => hit.sessionId === 'service-session'), true);
    });

    it('keeps tool output excluded by default and exposes it only with an explicit opt-in', () => {
      const file = path.join(tmpDir, 'tool-session.jsonl');
      fs.writeFileSync(file, [
        JSON.stringify({ type: 'session', id: 'tool-session', cwd: '/tool', timestamp: '2026-05-03T00:00:00Z' }),
        JSON.stringify({ type: 'message', id: 'tool-entry', timestamp: '2026-05-03T00:01:00Z', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'shell' }, { type: 'text', text: 'needle tool output' }] } }),
      ].join('\n') + '\n');
      indexLiveSession(dbManager, { getHeader: () => ({ id: 'tool-session', cwd: '/tool', timestamp: '2026-05-03T00:00:00Z' }), getEntries: () => [], getSessionFile: () => file });
      assert.deepStrictEqual(searchSessionEvidence(dbManager, 'needle').results, []);
      assert.strictEqual(searchSessionEvidence(dbManager, 'needle', { includeToolOutput: true }).results.length, 1);
    });

    it('centers a tail match and preserves Unicode boundaries', () => {
      const file = canonicalFile('emoji-session', `${'😀'.repeat(60)} prefix ${'x'.repeat(60)} needle tail`);
      indexLiveSession(dbManager, { getHeader: () => ({ id: 'emoji-session', cwd: '/emoji', timestamp: '2026-05-03T00:00:00Z' }), getEntries: () => [], getSessionFile: () => file });
      const hit = searchSessionEvidence(dbManager, 'needle', { snippetChars: 80 }).results[0];
      assert.ok(hit);
      assert.strictEqual(hit.snippet, `…prefix ${'x'.repeat(60)} needle tail`);
      assert.ok([...hit.snippet].length <= 80);
      assert.match(hit.snippet, /needle/);
      assert.doesNotMatch(hit.snippet, /\\uD800|\\uDC00/);
    });

    it('treats changed canonical JSONL content as authoritative over stale SQLite rows', () => {
      const file = canonicalFile('stale-session', 'needle from the old index');
      indexLiveSession(dbManager, { getHeader: () => ({ id: 'stale-session', cwd: '/canonical/project', timestamp: '2026-05-03T00:00:00Z' }), getEntries: () => [], getSessionFile: () => file });
      fs.writeFileSync(file, [
        JSON.stringify({ type: 'session', id: 'stale-session', cwd: '/canonical/project', timestamp: '2026-05-03T00:00:00Z' }),
        JSON.stringify({ type: 'message', id: 'stale-session-entry', timestamp: '2026-05-03T00:01:00Z', message: { role: 'user', content: 'canonical replacement' } }),
      ].join('\\n') + '\\n');
      const result = searchSessionEvidence(dbManager, 'needle');
      assert.deepStrictEqual(result.results, []);
    });
    it('revalidates canonical JSONL on the next search call', () => {
      const file = canonicalFile('request-boundary-session', 'needle from the old snapshot');
      indexLiveSession(dbManager, { getHeader: () => ({ id: 'request-boundary-session', cwd: '/canonical/project', timestamp: '2026-05-03T00:00:00Z' }), getEntries: () => [], getSessionFile: () => file });
      assert.strictEqual(searchSessionEvidence(dbManager, 'needle', { sessionsDir: tmpDir }).results.length, 1);
      fs.writeFileSync(file, [
        JSON.stringify({ type: 'session', id: 'request-boundary-session', cwd: '/canonical/project', timestamp: '2026-05-03T00:00:00Z' }),
        JSON.stringify({ type: 'message', id: 'request-boundary-session-entry', timestamp: '2026-05-03T00:01:00Z', message: { role: 'user', content: 'canonical replacement' } }),
      ].join('\n') + '\n');
      assert.deepStrictEqual(searchSessionEvidence(dbManager, 'needle', { sessionsDir: tmpDir }).results, []);
    });
  });

  describe('getIndexedMessageCount', () => {
    it('should return 0 for empty database', () => {
      assert.strictEqual(getIndexedMessageCount(dbManager), 0);
    });

    it('should return correct count after indexing', () => {
      indexSession(dbManager, createTestSession());
      assert.strictEqual(getIndexedMessageCount(dbManager), 6);
    });
  });
});
