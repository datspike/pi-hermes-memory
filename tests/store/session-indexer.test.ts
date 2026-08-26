import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseManager } from '../../src/store/db.js';
import {
  indexSession,
  indexAllSessions,
  indexChangedSessions,
  indexChangedSessionsBounded,
  getSessionStats,
  countSessionFiles,
  needsBackfill,
  touchBackfillTimestamp,
  LAST_SESSION_BACKFILL_KEY,
  indexCurrentSession,
  indexLiveSession,
  parseSessionManagerSnapshot,
  upsertSessionFileMetadata,
  setSessionIndexerFaultInjector,
  BACKFILL_MAX_FILE_BYTES,
  SESSION_BACKFILL_SCAN_CURSOR_KEY,
  SESSION_BACKFILL_DEFERRED_KEY,
} from '../../src/store/session-indexer.js';
import { parseSessionFile, type ParsedSession } from '../../src/store/session-parser.js';

describe('session-indexer', () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'indexer-test-'));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    setSessionIndexerFaultInjector();
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
        { id: `${id}-msg-1`, role: 'user', content: 'Hello', timestamp: '2026-05-03T00:01:00Z' },
        { id: `${id}-msg-2`, role: 'assistant', content: 'Hi there!', timestamp: '2026-05-03T00:01:30Z', toolCalls: ['read'] },
      ],
      ...overrides,
    };
  }

  describe('indexSession', () => {
    it('should index a session and its messages', () => {
      const session = createTestSession();
      const result = indexSession(dbManager, session);

      assert.strictEqual(result.sessionId, 'session-1');
      assert.strictEqual(result.messagesIndexed, 2);
      assert.strictEqual(result.skipped, false);

      // Verify in database
      const db = dbManager.getDb();
      const dbSession = db.prepare('SELECT * FROM sessions WHERE id = ?').get('session-1') as Record<string, unknown>;
      assert.strictEqual(dbSession.project, 'test-project');
      assert.strictEqual(dbSession.message_count, 2);

      const messages = db.prepare('SELECT * FROM messages WHERE session_id = ?').all('session-1') as Record<string, unknown>[];
      assert.strictEqual(messages.length, 2);
      assert.strictEqual(messages[0].role, 'user');
      assert.strictEqual(messages[1].role, 'assistant');
    });

    it('should store tool_calls as JSON', () => {
      const session = createTestSession();
      indexSession(dbManager, session);

      const db = dbManager.getDb();
      const msg = db.prepare('SELECT tool_calls FROM messages WHERE session_id = ? AND entry_id = ?').get('session-1', 'session-1-msg-2') as { tool_calls: string | null };
      assert.ok(msg.tool_calls);
      assert.deepStrictEqual(JSON.parse(msg.tool_calls), ['read']);
    });

    it('should skip already-indexed sessions with no new messages', () => {
      const session = createTestSession();

      const result1 = indexSession(dbManager, session);
      assert.strictEqual(result1.skipped, false);

      const result2 = indexSession(dbManager, session);
      assert.strictEqual(result2.skipped, true);
      assert.strictEqual(result2.messagesIndexed, 0);
    });

    it('should append missing messages for an already-indexed resumed session', () => {
      const session = createTestSession();
      indexSession(dbManager, session);

      const resumed = createTestSession({
        messages: [
          ...session.messages,
          { id: 'session-1-msg-3', role: 'user', content: 'Resumed later', timestamp: '2026-05-03T00:02:00Z' },
        ],
      });
      const result = indexSession(dbManager, resumed);

      assert.strictEqual(result.skipped, false);
      assert.strictEqual(result.messagesIndexed, 1);
      assert.strictEqual(dbManager.getStats().sessions, 1);
      assert.strictEqual(dbManager.getStats().messages, 3);

      const dbSession = dbManager.getDb().prepare('SELECT message_count FROM sessions WHERE id = ?').get('session-1') as { message_count: number };
      assert.strictEqual(dbSession.message_count, 3);
    });

    it('should handle sessions with no messages', () => {
      const session = createTestSession({ messages: [] });
      const result = indexSession(dbManager, session);

      assert.strictEqual(result.messagesIndexed, 0);
      assert.strictEqual(result.skipped, false);
    });
  });

  describe('indexAllSessions', () => {
    it('should index all JSONL files from disk', () => {
      // Create mock session directory structure
      const sessionsDir = path.join(tmpDir, 'sessions');
      const projDir = path.join(sessionsDir, 'test-project');
      fs.mkdirSync(projDir, { recursive: true });

      // Write a valid JSONL file
      const lines = [
        JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-05-03T00:00:00Z', cwd: '/test' }),
        JSON.stringify({
          type: 'message',
          id: 'm1',
          parentId: null,
          timestamp: '2026-05-03T00:01:00Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: Date.now() },
        }),
      ];
      fs.writeFileSync(path.join(projDir, 'session1.jsonl'), lines.join('\n'));

      const result = indexAllSessions(dbManager, sessionsDir);
      assert.strictEqual(result.sessionsProcessed, 1);
      assert.strictEqual(result.sessionsIndexed, 1);
      assert.strictEqual(result.messagesIndexed, 1);
      assert.strictEqual(result.errors.length, 0);
    });

    it('removes stale entries on same-file canonical rewrite while preserving unchanged physical IDs', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const filePath = path.join(sessionsDir, 'project', 's1.jsonl');
      const write = (ids: string[]) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, [
          JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-05-03T00:00:00Z', cwd: '/test/project' }),
          ...ids.map((id, index) => JSON.stringify({ type: 'message', id, parentId: null, timestamp: `2026-05-03T00:0${index + 1}:00Z`, message: { role: 'user', content: [{ type: 'text', text: id }] } })),
        ].join('\n'));
      };
      write(['keep', 'stale']);
      indexAllSessions(dbManager, sessionsDir);
      const before = dbManager.getDb().prepare('SELECT id FROM messages WHERE session_id = ? AND entry_id = ?').get('s1', 'keep') as { id: string };
      write(['keep', 'fresh']);
      indexAllSessions(dbManager, sessionsDir);
      const rows = dbManager.getDb().prepare('SELECT entry_id, id FROM messages WHERE session_id = ? ORDER BY ordinal').all('s1') as Array<{ entry_id: string; id: string }>;
      assert.deepStrictEqual(rows.map((row) => row.entry_id), ['keep', 'fresh']);
      assert.equal(rows[0].id, before.id);
    });

    it('removes disappeared files but keeps a valid older owner for the same session', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const write = (filePath: string, id: string, messageId: string) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, [
          JSON.stringify({ type: 'session', id, timestamp: '2026-05-03T00:00:00Z', cwd: '/test/project' }),
          JSON.stringify({ type: 'message', id: messageId, parentId: null, timestamp: '2026-05-03T00:01:00Z', message: { role: 'user', content: [{ type: 'text', text: messageId }] } }),
        ].join('\n'));
      };
      const older = path.join(sessionsDir, 'project', 'older.jsonl');
      const newer = path.join(sessionsDir, 'project', 'newer.jsonl');
      write(older, 'shared', 'older-entry');
      write(newer, 'shared', 'newer-entry');
      indexAllSessions(dbManager, sessionsDir);
      fs.rmSync(newer);
      indexAllSessions(dbManager, sessionsDir);
      const rows = dbManager.getDb().prepare('SELECT entry_id FROM messages WHERE session_id = ?').all('shared') as Array<{ entry_id: string }>;
      assert.deepStrictEqual(rows.map((row) => row.entry_id), ['older-entry']);
      assert.equal((dbManager.getDb().prepare('SELECT COUNT(*) AS count FROM session_files WHERE session_id = ?').get('shared') as { count: number }).count, 1);
    });

    it('transfers a reused path and purges the former owner only when it has no paths', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const filePath = path.join(sessionsDir, 'project', 'reused.jsonl');
      const write = (id: string, messageId: string) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, [
          JSON.stringify({ type: 'session', id, timestamp: '2026-05-03T00:00:00Z', cwd: '/test/project' }),
          JSON.stringify({ type: 'message', id: messageId, parentId: null, timestamp: '2026-05-03T00:01:00Z', message: { role: 'user', content: [{ type: 'text', text: messageId }] } }),
        ].join('\n'));
      };
      write('old-owner', 'old-entry');
      indexAllSessions(dbManager, sessionsDir);
      write('new-owner', 'new-entry');
      indexAllSessions(dbManager, sessionsDir);
      assert.equal((dbManager.getDb().prepare('SELECT COUNT(*) AS count FROM sessions WHERE id = ?').get('old-owner') as { count: number }).count, 0);
      assert.equal((dbManager.getDb().prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get('new-owner') as { count: number }).count, 1);
    });

    it('rolls back canonical ownership, rows, and purge on injected statement failure', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const filePath = path.join(sessionsDir, 'project', 'atomic.jsonl');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const write = (id: string, messageId: string) => fs.writeFileSync(filePath, [
        JSON.stringify({ type: 'session', id, timestamp: '2026-05-03T00:00:00Z', cwd: '/test/project' }),
        JSON.stringify({ type: 'message', id: messageId, parentId: null, timestamp: '2026-05-03T00:01:00Z', message: { role: 'user', content: [{ type: 'text', text: messageId }] } }),
      ].join('\n'));
      write('atomic-old', 'old-entry');
      indexAllSessions(dbManager, sessionsDir);
      write('atomic-new', 'new-entry');
      setSessionIndexerFaultInjector((statement) => { if (statement === 'upsert-session-file') throw new Error('injected'); });
      const result = indexAllSessions(dbManager, sessionsDir);
      assert.equal(result.errors.length, 1);
      assert.equal((dbManager.getDb().prepare('SELECT session_id FROM session_files WHERE path = ?').get(filePath) as { session_id: string }).session_id, 'atomic-old');
      assert.equal((dbManager.getDb().prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get('atomic-old') as { count: number }).count, 1);
      assert.equal((dbManager.getDb().prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get('atomic-new') as { count: number }).count, 0);
    });

    it('excludes same-session ambiguous logical IDs instead of last-write-wins', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const filePath = path.join(sessionsDir, 'project', 'ambiguous.jsonl');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: 'session', id: 'ambiguous', timestamp: '2026-05-03T00:00:00Z', cwd: '/test/project' }),
        JSON.stringify({ type: 'message', id: 'same', parentId: null, timestamp: '2026-05-03T00:01:00Z', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } }),
        JSON.stringify({ type: 'message', id: 'same', parentId: null, timestamp: '2026-05-03T00:02:00Z', message: { role: 'user', content: [{ type: 'text', text: 'second' }] } }),
      ].join('\n'));
      indexAllSessions(dbManager, sessionsDir);
      assert.equal((dbManager.getDb().prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get('ambiguous') as { count: number }).count, 0);
    });

    it('does not delete entries absent from a partial live snapshot', () => {
      indexSession(dbManager, createTestSession({ id: 'partial', messages: [
        { id: 'present', role: 'user', content: 'present', timestamp: '2026-05-03T00:01:00Z' },
        { id: 'later', role: 'assistant', content: 'later', timestamp: '2026-05-03T00:02:00Z' },
      ] }));
      indexSession(dbManager, createTestSession({ id: 'partial', messages: [
        { id: 'present', role: 'user', content: 'present', timestamp: '2026-05-03T00:01:00Z' },
      ] }));
      assert.equal((dbManager.getDb().prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get('partial') as { count: number }).count, 2);
    });

    it('should skip already-indexed sessions on re-run', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const projDir = path.join(sessionsDir, 'test-project');
      fs.mkdirSync(projDir, { recursive: true });

      const lines = [
        JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-05-03T00:00:00Z', cwd: '/test' }),
        JSON.stringify({
          type: 'message',
          id: 'm1',
          parentId: null,
          timestamp: '2026-05-03T00:01:00Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: Date.now() },
        }),
      ];
      fs.writeFileSync(path.join(projDir, 'session1.jsonl'), lines.join('\n'));

      // First run
      const result1 = indexAllSessions(dbManager, sessionsDir);
      assert.strictEqual(result1.sessionsIndexed, 1);

      // Second run — should skip
      const result2 = indexAllSessions(dbManager, sessionsDir);
      assert.strictEqual(result2.sessionsSkipped, 1);
      assert.strictEqual(result2.sessionsIndexed, 0);
    });

    it('should handle invalid JSONL files gracefully', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const projDir = path.join(sessionsDir, 'test-project');
      fs.mkdirSync(projDir, { recursive: true });

      // Invalid file (no session entry)
      fs.writeFileSync(path.join(projDir, 'invalid.jsonl'), '{"type":"message","id":"m1"}');

      const result = indexAllSessions(dbManager, sessionsDir);
      assert.strictEqual(result.sessionsProcessed, 1);
      assert.strictEqual(result.errors.length, 1);
    });

    it('should handle empty sessions directory', () => {
      const sessionsDir = path.join(tmpDir, 'empty-sessions');
      fs.mkdirSync(sessionsDir);

      const result = indexAllSessions(dbManager, sessionsDir);
      assert.strictEqual(result.sessionsProcessed, 0);
      assert.strictEqual(result.sessionsIndexed, 0);
    });

    it('should handle non-existent sessions directory', () => {
      const result = indexAllSessions(dbManager, '/nonexistent/path');
      assert.strictEqual(result.sessionsProcessed, 0);
    });
  });

  describe('indexChangedSessions', () => {
    function writeJsonlSession(filePath: string, sessionId: string, messageIds = [`${sessionId}-m1`]): void {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const lines = [
        JSON.stringify({ type: 'session', id: sessionId, timestamp: '2026-05-03T00:00:00Z', cwd: `/test/${sessionId}` }),
        ...messageIds.map((id, index) => JSON.stringify({
          type: 'message',
          id,
          parentId: null,
          timestamp: `2026-05-03T00:0${index + 1}:00Z`,
          message: { role: 'user', content: [{ type: 'text', text: `Hello ${id}` }], timestamp: Date.now() },
        })),
      ];
      fs.writeFileSync(filePath, lines.join('\n'));
    }

    it('skips unchanged files using stored size and mtime metadata without parsing them', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const filePath = path.join(sessionsDir, 'project-a', 's1.jsonl');
      writeJsonlSession(filePath, 's1');
      indexAllSessions(dbManager, sessionsDir);

      const result = indexChangedSessions(dbManager, sessionsDir);

      assert.strictEqual(result.sessionsProcessed, 0);
      assert.strictEqual(result.sessionsSkipped, 1);
      assert.strictEqual(result.errors.length, 0);
    });

    it('indexes changed files and appends newly persisted messages', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const filePath = path.join(sessionsDir, 'project-a', 's1.jsonl');
      writeJsonlSession(filePath, 's1', ['s1-m1']);
      indexAllSessions(dbManager, sessionsDir);

      writeJsonlSession(filePath, 's1', ['s1-m1', 's1-m2']);
      const result = indexChangedSessions(dbManager, sessionsDir);

      assert.strictEqual(result.sessionsProcessed, 1);
      assert.strictEqual(result.sessionsIndexed, 1);
      assert.strictEqual(result.messagesIndexed, 1);
      assert.strictEqual(dbManager.getStats().messages, 2);
    });

    it('parses existing sessions without file metadata and appends missed messages', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const filePath = path.join(sessionsDir, 'project-a', 's1.jsonl');
      indexSession(dbManager, createTestSession({
        id: 's1',
        messages: [
          { id: 's1-m1', role: 'user', content: 'Hello s1-m1', timestamp: '2026-05-03T00:01:00Z' },
        ],
      }));
      writeJsonlSession(filePath, 's1', ['s1-m1', 's1-m2']);

      const result = indexChangedSessions(dbManager, sessionsDir);

      assert.strictEqual(result.sessionsProcessed, 1);
      assert.strictEqual(result.sessionsIndexed, 1);
      assert.strictEqual(result.messagesIndexed, 1);
      assert.strictEqual(dbManager.getStats().messages, 2);
    });

    it('caps parsed files during startup incremental backfill', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      writeJsonlSession(path.join(sessionsDir, 'project-a', 's1.jsonl'), 's1');
      writeJsonlSession(path.join(sessionsDir, 'project-a', 's2.jsonl'), 's2');

      const result = indexChangedSessions(dbManager, sessionsDir, { maxFilesToIndex: 1 });

      assert.strictEqual(result.sessionsProcessed, 1);
      assert.strictEqual(result.reachedLimit, true);
      assert.strictEqual(dbManager.getStats().sessions, 1);
    });

    it('processes the most recently modified changed files first when the cap is reached', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      // Write an older file first, then a newer one. With newest-first ordering
      // the newer file must be indexed even when the cap only allows one file.
      const olderPath = path.join(sessionsDir, 'project-a', 'older.jsonl');
      const newerPath = path.join(sessionsDir, 'project-a', 'newer.jsonl');
      writeJsonlSession(olderPath, 'older');
      // Ensure a measurable mtime gap (some filesystems have coarse mtime resolution).
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(olderPath, past, past);
      writeJsonlSession(newerPath, 'newer');

      const result = indexChangedSessions(dbManager, sessionsDir, { maxFilesToIndex: 1 });

      assert.strictEqual(result.sessionsProcessed, 1);
      assert.strictEqual(result.reachedLimit, true);
      assert.strictEqual(dbManager.getStats().sessions, 1);
      // The newer file should be the one indexed.
      const indexed = dbManager.getDb().prepare('SELECT id FROM sessions').all() as { id: string }[];
      assert.deepStrictEqual(indexed.map((r) => r.id), ['newer']);
    });

    it('uses one canonical file identity for lexical symlink and realpath aliases', () => {
      const realRoot = path.join(tmpDir, 'real-sessions');
      const aliasRoot = path.join(tmpDir, 'alias-sessions');
      writeJsonlSession(path.join(realRoot, 'project-a', 'alias-session.jsonl'), 'alias-session');
      fs.symlinkSync(realRoot, aliasRoot, 'dir');

      const first = indexChangedSessions(dbManager, aliasRoot);
      const second = indexChangedSessions(dbManager, realRoot);

      assert.equal(first.sessionsIndexed, 1);
      assert.equal(second.sessionsProcessed, 0);
      assert.equal(second.sessionsSkipped, 1);
      assert.equal((dbManager.getDb().prepare('SELECT COUNT(*) AS count FROM session_files').get() as { count: number }).count, 1);
    });

    it('defers an oversized JSONL file and does not write a completion watermark', async () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const filePath = path.join(sessionsDir, 'project-a', 'large.jsonl');
      writeJsonlSession(filePath, 'large', ['x'.repeat(BACKFILL_MAX_FILE_BYTES)]);
      const result = await indexChangedSessionsBounded(dbManager, sessionsDir, { maxDurationMs: 1000 });

      assert.equal(result.deferredFiles, 1);
      assert.equal(result.partial, true);
      assert.equal(dbManager.getStats().sessions, 0);
    });

    it('enforces total-byte and wall-clock budgets while yielding between files', async () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      writeJsonlSession(path.join(sessionsDir, 'project-a', 'one.jsonl'), 'budget-one');
      writeJsonlSession(path.join(sessionsDir, 'project-a', 'two.jsonl'), 'budget-two');
      let yields = 0;
      const totalLimited = await indexChangedSessionsBounded(dbManager, sessionsDir, {
        maxTotalBytes: 1,
        maxDurationMs: 1000,
        yieldFn: async () => { yields++; },
      });
      assert.equal(totalLimited.partial, true);
      assert.equal(totalLimited.deferredFiles, 2);
      assert.equal(yields >= 2, true);

      const deadlineLimited = await indexChangedSessionsBounded(dbManager, sessionsDir, { maxDurationMs: 0 });
      assert.equal(deadlineLimited.partial, true);
      assert.equal(deadlineLimited.sessionsProcessed, 0);
    });

    it('persists a canonical discovery cursor and reaches the tail across deadline-limited starts after reopen', async () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      for (const id of ['a', 'b', 'c']) writeJsonlSession(path.join(sessionsDir, 'project-a', `${id}.jsonl`), `cursor-${id}`);
      let yields = 0;
      const first = await indexChangedSessionsBounded(dbManager, sessionsDir, {
        maxDurationMs: 50,
        yieldFn: async () => { if (++yields === 1) await new Promise((resolve) => setTimeout(resolve, 100)); },
      });
      assert.equal(first.partial, true);
      const cursor = dbManager.getDb().prepare('SELECT value FROM extension_metadata WHERE key = ?').get(SESSION_BACKFILL_SCAN_CURSOR_KEY) as { value: string };
      assert.ok(cursor.value);
      dbManager.close();
      dbManager = new DatabaseManager(path.join(tmpDir, 'memory'));
      const second = await indexChangedSessionsBounded(dbManager, sessionsDir, { maxDurationMs: 1000 });
      assert.equal(second.sessionsIndexed >= 2, true);
      assert.equal(dbManager.getDb().prepare('SELECT value FROM extension_metadata WHERE key = ?').get(SESSION_BACKFILL_SCAN_CURSOR_KEY), undefined);
      assert.equal(dbManager.getStats().sessions, 3);
    });

    it('remembers stable oversized fingerprints, retries only after change, and leaves manual indexing unbounded', async () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const largePath = path.join(sessionsDir, 'project-a', 'large.jsonl');
      writeJsonlSession(largePath, 'deferred-large', ['x'.repeat(BACKFILL_MAX_FILE_BYTES)]);
      const first = await indexChangedSessionsBounded(dbManager, sessionsDir, { maxDurationMs: 1000 });
      const second = await indexChangedSessionsBounded(dbManager, sessionsDir, { maxDurationMs: 1000 });
      assert.equal(first.deferredFiles, 1);
      assert.equal(second.deferredFiles, 1);
      assert.equal(second.sessionsProcessed, 0);
      assert.match((dbManager.getDb().prepare('SELECT value FROM extension_metadata WHERE key = ?').get(SESSION_BACKFILL_DEFERRED_KEY) as { value: string }).value, /large\.jsonl/);

      writeJsonlSession(largePath, 'deferred-large', ['changed-small']);
      const changed = await indexChangedSessionsBounded(dbManager, sessionsDir, { maxDurationMs: 1000 });
      assert.equal(changed.sessionsIndexed, 1);
      assert.equal(dbManager.getDb().prepare('SELECT value FROM extension_metadata WHERE key = ?').get(SESSION_BACKFILL_DEFERRED_KEY), undefined);

      const manualPath = path.join(sessionsDir, 'project-a', 'manual-large.jsonl');
      writeJsonlSession(manualPath, 'manual-large', ['y'.repeat(BACKFILL_MAX_FILE_BYTES)]);
      await indexChangedSessionsBounded(dbManager, sessionsDir, { maxDurationMs: 1000 });
      const manual = indexAllSessions(dbManager, sessionsDir);
      assert.equal(manual.sessionsIndexed >= 1, true);
    });

    it('reports cancellation before parsing and leaves the DB untouched', async () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      writeJsonlSession(path.join(sessionsDir, 'project-a', 'cancelled.jsonl'), 'cancelled');
      const controller = new AbortController();
      controller.abort();
      const result = await indexChangedSessionsBounded(dbManager, sessionsDir, { signal: controller.signal, maxDurationMs: 1000 });
      assert.equal(result.aborted, true);
      assert.equal(result.partial, true);
      assert.equal(dbManager.getStats().sessions, 0);
    });

    it('does not open or touch the database when already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      let opened = false;
      const guarded = {
        getDb: () => { opened = true; throw new Error('database opened after abort'); },
      } as unknown as DatabaseManager;
      const result = await indexChangedSessionsBounded(guarded, path.join(tmpDir, 'sessions'), { signal: controller.signal });
      assert.equal(result.aborted, true);
      assert.equal(result.partial, true);
      assert.equal(opened, false);
    });

    it('enforces the file and total byte budgets when a file grows after stat', async () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const filePath = path.join(sessionsDir, 'project-a', 'growing.jsonl');
      writeJsonlSession(filePath, 'growing', ['small']);
      let yields = 0;
      const result = await indexChangedSessionsBounded(dbManager, sessionsDir, {
        maxFileBytes: 256,
        maxTotalBytes: 256,
        maxDurationMs: 1000,
        yieldFn: async () => {
          if (++yields === 3) fs.appendFileSync(filePath, 'x'.repeat(512));
        },
      });
      assert.equal(result.deferredFiles, 1);
      assert.equal(result.sessionsIndexed, 0);
      assert.equal(dbManager.getStats().sessions, 0);
    });

    it('canonicalizes live session file ownership across lexical aliases', () => {
      const realRoot = path.join(tmpDir, 'real-live');
      const aliasRoot = path.join(tmpDir, 'alias-live');
      const realFile = path.join(realRoot, 'project-a', 'live.jsonl');
      writeJsonlSession(path.join(realRoot, 'project-a', 'live.jsonl'), 'live');
      fs.symlinkSync(realRoot, aliasRoot, 'dir');
      const snapshot = { getHeader: () => ({ id: 'live', timestamp: '2026-05-03T00:00:00Z', cwd: '/work/project-a' }), getEntries: () => [], getSessionFile: () => path.join(aliasRoot, 'project-a', 'live.jsonl') };
      indexLiveSession(dbManager, snapshot);
      indexLiveSession(dbManager, { ...snapshot, getSessionFile: () => realFile });
      assert.equal((dbManager.getDb().prepare('SELECT COUNT(*) AS count FROM session_files').get() as { count: number }).count, 1);
    });

    it('advances capped progress across repeated bounded starts and accepts the legacy string first-message format', async () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const older = path.join(sessionsDir, 'project-a', 'older.jsonl');
      const newer = path.join(sessionsDir, 'project-a', 'newer.jsonl');
      writeJsonlSession(older, 'legacy-older', ['legacy-older-m1']);
      fs.writeFileSync(older, [
        JSON.stringify({ type: 'session', id: 'legacy-older', timestamp: '2026-05-03T00:00:00Z', cwd: '/test/legacy' }),
        JSON.stringify({ type: 'message', id: 'legacy-older-m1', parentId: null, timestamp: '2026-05-03T00:01:00Z', message: { role: 'user', content: 'legacy string content' } }),
      ].join('\n'));
      fs.utimesSync(older, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
      writeJsonlSession(newer, 'legacy-newer', ['legacy-newer-m1']);

      const first = await indexChangedSessionsBounded(dbManager, sessionsDir, { maxFilesToIndex: 1, maxDurationMs: 1000 });
      const second = await indexChangedSessionsBounded(dbManager, sessionsDir, { maxFilesToIndex: 1, maxDurationMs: 1000 });

      assert.equal(first.sessionsIndexed, 1);
      assert.equal(first.reachedLimit, true);
      assert.equal(second.sessionsIndexed, 1);
      assert.equal(second.reachedLimit, undefined);
      assert.equal(dbManager.getStats().sessions, 2);
      assert.equal(dbManager.getStats().messages, 2);
    });
  });

  describe('current session indexing helpers', () => {
    function writeSessionFile(filePath: string): void {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const lines = [
        JSON.stringify({ type: 'session', id: 'file-session-1', timestamp: '2026-05-03T00:00:00Z', cwd: '/work/file-project' }),
        JSON.stringify({
          type: 'message',
          id: 'file-entry-1',
          parentId: null,
          timestamp: '2026-05-03T00:01:00Z',
          message: { role: 'user', content: [{ type: 'text', text: 'from persisted file' }], timestamp: Date.now() },
        }),
      ];
      fs.writeFileSync(filePath, lines.join('\n'));
    }

    function createSessionManagerSnapshot(entries: unknown[] = []) {
      return {
        getHeader: () => ({ id: 'live-session-1', timestamp: '2026-05-03T00:00:00Z', cwd: '/work/live-project' }),
        getEntries: () => entries,
      };
    }

    it('parseSessionManagerSnapshot converts current session entries into ParsedSession', () => {
      const snapshot = createSessionManagerSnapshot([
        {
          type: 'message',
          id: 'entry-1',
          timestamp: '2026-05-03T00:01:00Z',
          message: { role: 'user', content: 'Hello live session' },
        },
        {
          type: 'message',
          id: 'entry-2',
          timestamp: '2026-05-03T00:02:00Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }, { type: 'toolCall', name: 'read' }] },
        },
        {
          type: 'message',
          id: 'entry-3',
          timestamp: '2026-05-03T00:03:00Z',
          message: { role: 'toolResult', content: [{ type: 'text', text: 'tool output is not indexed by current schema' }] },
        },
      ]);

      const parsed = parseSessionManagerSnapshot(snapshot);

      assert.ok(parsed);
      assert.strictEqual(parsed.id, 'live-session-1');
      assert.strictEqual(parsed.project, 'live-project');
      assert.strictEqual(parsed.messages.length, 3);
      assert.deepStrictEqual(parsed.messages[1].toolCalls, ['read']);
      assert.equal(parsed.messages[2].kind, 'tool_result');
    });

    it('indexLiveSession prefers the persisted JSONL file when available', () => {
      const filePath = path.join(tmpDir, 'sessions', 'project', 'file-session.jsonl');
      writeSessionFile(filePath);
      const snapshot = {
        getHeader: () => ({ id: 'stale-memory-session', timestamp: '2026-05-03T00:00:00Z', cwd: '/work/stale' }),
        getEntries: () => [],
        getSessionFile: () => filePath,
      };

      const result = indexLiveSession(dbManager, snapshot);

      assert.ok(result);
      assert.strictEqual(result.sessionId, 'file-session-1');
      assert.strictEqual(result.messagesIndexed, 1);
      const indexed = dbManager.getDb().prepare('SELECT id, cwd FROM sessions WHERE id = ?').get('file-session-1') as { id: string; cwd: string };
      assert.strictEqual(indexed.cwd, '/work/file-project');
    });

    it('uses the live snapshot instead of reparsing a persisted file when entries are available', () => {
      const filePath = path.join(tmpDir, 'sessions', 'project', 'stale-session.jsonl');
      writeSessionFile(filePath);
      const snapshot = {
        getHeader: () => ({ id: 'live-session-1', timestamp: '2026-05-03T00:00:00Z', cwd: '/work/live-project' }),
        getEntries: () => [{
          type: 'message',
          id: 'live-entry-1',
          parentId: null,
          timestamp: '2026-05-03T00:02:00Z',
          message: { role: 'user', content: 'from live snapshot' },
        }],
        getSessionFile: () => filePath,
      };

      const result = indexLiveSession(dbManager, snapshot);

      assert.ok(result);
      assert.strictEqual(result.sessionId, 'live-session-1');
      assert.strictEqual(result.messagesIndexed, 1);
      assert.equal(dbManager.getDb().prepare('SELECT 1 FROM sessions WHERE id = ?').get('file-session-1'), undefined);
    });

    it('appends live entries after a canonical disk index without mixing ordinal coordinates', () => {
      const filePath = path.join(tmpDir, 'sessions', 'project', 'file-session.jsonl');
      writeSessionFile(filePath);
      const entries = [
        {
          type: 'message',
          id: 'file-entry-1',
          parentId: null,
          timestamp: '2026-05-03T00:01:00Z',
          message: { role: 'user', content: [{ type: 'text', text: 'from persisted file' }] },
        },
        {
          type: 'message',
          id: 'file-entry-2',
          parentId: 'file-entry-1',
          timestamp: '2026-05-03T00:02:00Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'new live message' }] },
        },
      ];
      const snapshot = {
        getHeader: () => ({ id: 'file-session-1', timestamp: '2026-05-03T00:00:00Z', cwd: '/work/file-project' }),
        getEntries: () => entries,
        getSessionFile: () => filePath,
      };

      indexLiveSession(dbManager, { ...snapshot, getEntries: () => [] });
      fs.appendFileSync(filePath, `\n${JSON.stringify(entries[1])}`);
      const result = indexLiveSession(dbManager, snapshot);

      assert.ok(result);
      assert.strictEqual(result.messagesIndexed, 1);
      const rows = dbManager.getDb().prepare('SELECT entry_id, ordinal FROM messages WHERE session_id = ? ORDER BY ordinal').all('file-session-1') as Array<{ entry_id: string; ordinal: number }>;
      assert.deepStrictEqual(rows, [
        { entry_id: 'file-entry-1', ordinal: 1 },
        { entry_id: 'file-entry-2', ordinal: 2 },
      ]);
    });

    it('falls back to the canonical file when the indexed live cursor content is stale', () => {
      const filePath = path.join(tmpDir, 'sessions', 'project', 'file-session.jsonl');
      writeSessionFile(filePath);
      const header = { id: 'file-session-1', timestamp: '2026-05-03T00:00:00Z', cwd: '/work/file-project' };
      indexLiveSession(dbManager, { getHeader: () => header, getEntries: () => [], getSessionFile: () => filePath });
      const updatedEntry = {
        type: 'message',
        id: 'file-entry-1',
        parentId: null,
        timestamp: '2026-05-03T00:01:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'updated canonical content' }] },
      };
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: 'session', ...header }),
        JSON.stringify(updatedEntry),
      ].join('\n'));

      const result = indexLiveSession(dbManager, {
        getHeader: () => header,
        getEntries: () => [updatedEntry],
        getSessionFile: () => filePath,
      });

      assert.ok(result);
      const row = dbManager.getDb().prepare('SELECT content FROM messages WHERE session_id = ? AND entry_id = ?').get('file-session-1', 'file-entry-1') as { content: string };
      assert.strictEqual(row.content, 'updated canonical content');
    });

    it('does not republish a live cursor removed by canonical reconciliation', () => {
      const filePath = path.join(tmpDir, 'sessions', 'project', 'file-session.jsonl');
      writeSessionFile(filePath);
      const header = { id: 'file-session-1', timestamp: '2026-05-03T00:00:00Z', cwd: '/work/file-project' };
      const staleEntry = {
        type: 'message',
        id: 'file-entry-1',
        parentId: null,
        timestamp: '2026-05-03T00:01:00Z',
        message: { role: 'user', content: 'stale live payload' },
      };
      indexLiveSession(dbManager, { getHeader: () => header, getEntries: () => [], getSessionFile: () => filePath });
      fs.writeFileSync(filePath, JSON.stringify({ type: 'session', ...header }));

      const result = indexLiveSession(dbManager, {
        getHeader: () => header,
        getEntries: () => [staleEntry],
        getSessionFile: () => filePath,
      });

      assert.ok(result);
      assert.strictEqual((dbManager.getDb().prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get(header.id) as { count: number }).count, 0);
    });

    it('does not restore a canonical tail removed before a stale live snapshot arrives', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const filePath = path.join(sessionsDir, 'project', 'tail-session.jsonl');
      const header = { id: 'tail-session', timestamp: '2026-05-03T00:00:00Z', cwd: '/work/tail-project' };
      const entry1 = { type: 'message', id: 'tail-entry-1', parentId: null, timestamp: '2026-05-03T00:01:00Z', message: { role: 'user', content: 'kept' } };
      const entry2 = { type: 'message', id: 'tail-entry-2', parentId: 'tail-entry-1', timestamp: '2026-05-03T00:02:00Z', message: { role: 'assistant', content: 'removed tail' } };
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, [JSON.stringify({ type: 'session', ...header }), JSON.stringify(entry1), JSON.stringify(entry2)].join('\n'));
      indexAllSessions(dbManager, sessionsDir);
      fs.writeFileSync(filePath, [JSON.stringify({ type: 'session', ...header }), JSON.stringify(entry1)].join('\n'));
      indexAllSessions(dbManager, sessionsDir);

      const result = indexLiveSession(dbManager, {
        getHeader: () => header,
        getEntries: () => [entry1, entry2],
        getSessionFile: () => filePath,
      }, sessionsDir);

      assert.ok(result);
      assert.strictEqual(result.messagesIndexed, 0);
      assert.strictEqual((dbManager.getDb().prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ? AND entry_id = ?').get(header.id, entry2.id) as { count: number }).count, 0);
    });

    it('fails closed for malformed, non-contained, or foreign canonical sources during stale reconciliation', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const filePath = path.join(sessionsDir, 'project', 'file-session.jsonl');
      writeSessionFile(filePath);
      const header = { id: 'file-session-1', timestamp: '2026-05-03T00:00:00Z', cwd: '/work/file-project' };
      const changedEntry = {
        type: 'message',
        id: 'file-entry-1',
        parentId: null,
        timestamp: '2026-05-03T00:01:00Z',
        message: { role: 'user', content: 'untrusted changed payload' },
      };
      indexLiveSession(dbManager, { getHeader: () => header, getEntries: () => [], getSessionFile: () => filePath }, sessionsDir);

      const malformedPath = path.join(sessionsDir, 'project', 'malformed.jsonl');
      fs.writeFileSync(malformedPath, '{not-json');
      assert.strictEqual(indexLiveSession(dbManager, { getHeader: () => header, getEntries: () => [changedEntry], getSessionFile: () => malformedPath }, sessionsDir), null);

      const outsidePath = path.join(tmpDir, 'outside.jsonl');
      fs.writeFileSync(outsidePath, fs.readFileSync(filePath));
      assert.strictEqual(indexLiveSession(dbManager, { getHeader: () => header, getEntries: () => [changedEntry], getSessionFile: () => outsidePath }, sessionsDir), null);

      const foreignPath = path.join(sessionsDir, 'project', 'foreign.jsonl');
      fs.writeFileSync(foreignPath, [
        JSON.stringify({ type: 'session', id: 'foreign-session', timestamp: header.timestamp, cwd: header.cwd }),
        JSON.stringify({ ...changedEntry, id: 'foreign-entry' }),
      ].join('\n'));
      assert.strictEqual(indexLiveSession(dbManager, { getHeader: () => header, getEntries: () => [changedEntry], getSessionFile: () => foreignPath }, sessionsDir), null);
      assert.equal(dbManager.getDb().prepare('SELECT 1 FROM sessions WHERE id = ?').get('foreign-session'), undefined);
      const row = dbManager.getDb().prepare('SELECT content FROM messages WHERE session_id = ? AND entry_id = ?').get(header.id, 'file-entry-1') as { content: string };
      assert.strictEqual(row.content, 'from persisted file');
    });

    it('reconciles a changed tool call identity even when text and timestamp are unchanged', () => {
      const filePath = path.join(tmpDir, 'sessions', 'project', 'tool-session.jsonl');
      const header = { id: 'tool-session', timestamp: '2026-05-03T00:00:00Z', cwd: '/work/tool-project' };
      const makeEntry = (toolCallId: string) => ({
        type: 'message',
        id: 'tool-entry',
        parentId: null,
        timestamp: '2026-05-03T00:01:00Z',
        message: { role: 'toolResult', toolName: 'read', toolCallId, content: [{ type: 'text', text: 'same result' }] },
      });
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, [JSON.stringify({ type: 'session', ...header }), JSON.stringify(makeEntry('call-old'))].join('\n'));
      indexLiveSession(dbManager, { getHeader: () => header, getEntries: () => [], getSessionFile: () => filePath });
      const updatedEntry = makeEntry('call-new');
      fs.writeFileSync(filePath, [JSON.stringify({ type: 'session', ...header }), JSON.stringify(updatedEntry)].join('\n'));

      const result = indexLiveSession(dbManager, { getHeader: () => header, getEntries: () => [updatedEntry], getSessionFile: () => filePath });

      assert.ok(result);
      const row = dbManager.getDb().prepare('SELECT tool_name, tool_call_id FROM messages WHERE session_id = ? AND entry_id = ?').get(header.id, 'tool-entry') as { tool_name: string; tool_call_id: string };
      assert.deepStrictEqual(row, { tool_name: 'read', tool_call_id: 'call-new' });
    });

    it('preserves SessionManager method receivers on the live snapshot path', () => {
      const snapshot = {
        header: { id: 'bound-live-session', timestamp: '2026-05-03T00:00:00Z', cwd: '/work/live-project' },
        entries: [{
          type: 'message',
          id: 'bound-live-entry',
          parentId: null,
          timestamp: '2026-05-03T00:02:00Z',
          message: { role: 'user', content: 'bound receiver' },
        }],
        getHeader() { return this.header; },
        getEntries() { return this.entries; },
      };

      const result = indexLiveSession(dbManager, snapshot);

      assert.ok(result);
      assert.strictEqual(result.sessionId, 'bound-live-session');
      assert.strictEqual(result.messagesIndexed, 1);
    });

    it('indexCurrentSession indexes missing live messages idempotently', () => {
      const entries = [
        {
          type: 'message',
          id: 'entry-1',
          timestamp: '2026-05-03T00:01:00Z',
          message: { role: 'user', content: 'Hello live session' },
        },
      ];
      const snapshot = createSessionManagerSnapshot(entries);

      const result1 = indexCurrentSession(dbManager, snapshot);
      assert.ok(result1);
      assert.strictEqual(result1.messagesIndexed, 1);
      assert.strictEqual(dbManager.getStats().sessions, 1);
      assert.strictEqual(dbManager.getStats().messages, 1);

      entries.push({
        type: 'message',
        id: 'entry-2',
        timestamp: '2026-05-03T00:02:00Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi again' }] },
      });
      const result2 = indexCurrentSession(dbManager, snapshot);
      assert.ok(result2);
      assert.strictEqual(result2.messagesIndexed, 1);
      assert.strictEqual(dbManager.getStats().sessions, 1);
      assert.strictEqual(dbManager.getStats().messages, 2);

      const result3 = indexCurrentSession(dbManager, snapshot);
      assert.ok(result3);
      assert.strictEqual(result3.skipped, true);
      assert.strictEqual(result3.messagesIndexed, 0);
    });

    it('uses the indexed cursor ordinal when a partial snapshot contains only new entries', () => {
      indexSession(dbManager, createTestSession({
        id: 'live-session-1',
        messages: [{
          id: 'entry-1',
          entryId: 'entry-1',
          ordinal: 1,
          role: 'user',
          content: 'persisted cursor',
          timestamp: '2026-05-03T00:01:00Z',
        }],
      }));
      const snapshot = createSessionManagerSnapshot([{
        type: 'message',
        id: 'entry-2',
        parentId: 'entry-1',
        timestamp: '2026-05-03T00:02:00Z',
        message: { role: 'assistant', content: 'partial append' },
      }]);

      const result = indexCurrentSession(dbManager, snapshot);

      assert.ok(result);
      assert.strictEqual(result.messagesIndexed, 1);
      const row = dbManager.getDb().prepare('SELECT ordinal FROM messages WHERE session_id = ? AND entry_id = ?').get('live-session-1', 'entry-2') as { ordinal: number };
      assert.strictEqual(row.ordinal, 2);
    });

    it('indexes a physically appended branch message after the existing live cursor', () => {
      const entries = [
        {
          type: 'message',
          id: 'branch-root',
          parentId: null,
          timestamp: '2026-05-03T00:01:00Z',
          message: { role: 'user', content: 'root' },
        },
        {
          type: 'message',
          id: 'old-leaf',
          parentId: 'branch-root',
          timestamp: '2026-05-03T00:02:00Z',
          message: { role: 'assistant', content: 'old leaf' },
        },
      ];
      const snapshot = createSessionManagerSnapshot(entries);
      indexCurrentSession(dbManager, snapshot);
      entries.push({
        type: 'message',
        id: 'new-branch-leaf',
        parentId: 'branch-root',
        timestamp: '2026-05-03T00:03:00Z',
        message: { role: 'user', content: 'new branch' },
      });

      const result = indexCurrentSession(dbManager, snapshot);

      assert.ok(result);
      assert.strictEqual(result.messagesIndexed, 1);
      const row = dbManager.getDb().prepare('SELECT parent_entry_id, ordinal FROM messages WHERE session_id = ? AND entry_id = ?').get('live-session-1', 'new-branch-leaf') as { parent_entry_id: string; ordinal: number };
      assert.deepStrictEqual(row, { parent_entry_id: 'branch-root', ordinal: 2 });
    });

    it('recovers corruption when indexCurrentSession is called directly', () => {
      const snapshot = createSessionManagerSnapshot([{
        type: 'message',
        id: 'entry-after-recovery',
        timestamp: '2026-05-03T00:01:00Z',
        message: { role: 'user', content: 'recover me' },
      }]);
      let injected = false;
      setSessionIndexerFaultInjector((statement) => {
        if (!injected && statement === 'insert-session') {
          injected = true;
          const error = new Error('database disk image is malformed') as Error & { code: string };
          error.code = 'SQLITE_CORRUPT';
          throw error;
        }
      });

      assert.throws(
        () => indexCurrentSession(dbManager, snapshot),
        (error: Error & { code?: string }) => error.code === 'SQLITE_CORRUPT',
      );
      assert.ok(dbManager.getLastRecovery());
    });

    it('does not upsert the full live history again when there are no new entries', () => {
      const entries = Array.from({ length: 1_000 }, (_, index) => ({
        type: 'message',
        id: `entry-${index}`,
        parentId: index === 0 ? null : `entry-${index - 1}`,
        timestamp: '2026-05-03T00:01:00Z',
        message: { role: index % 2 === 0 ? 'user' : 'assistant', content: `message ${index}` },
      }));
      const snapshot = createSessionManagerSnapshot(entries);

      const first = indexCurrentSession(dbManager, snapshot);
      assert.ok(first);
      assert.strictEqual(first.messagesIndexed, entries.length);

      let upserts = 0;
      setSessionIndexerFaultInjector((statement) => {
        if (statement === 'upsert-message') upserts++;
      });
      const repeated = indexCurrentSession(dbManager, snapshot);

      assert.ok(repeated);
      assert.strictEqual(repeated.messagesIndexed, 0);
      assert.strictEqual(repeated.skipped, true);
      assert.strictEqual(upserts, 0);
    });
  });

  describe('backfill metadata helpers', () => {
    function writeJsonlSession(sessionsDir: string, projectDir: string, sessionId: string): void {
      const projDir = path.join(sessionsDir, projectDir);
      fs.mkdirSync(projDir, { recursive: true });
      const lines = [
        JSON.stringify({ type: 'session', id: sessionId, timestamp: '2026-05-03T00:00:00Z', cwd: `/test/${projectDir}` }),
        JSON.stringify({
          type: 'message',
          id: `${sessionId}-m1`,
          parentId: null,
          timestamp: '2026-05-03T00:01:00Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: Date.now() },
        }),
      ];
      fs.writeFileSync(path.join(projDir, `${sessionId}.jsonl`), lines.join('\n'));
    }

    it('countSessionFiles counts JSONL files in session project directories', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      writeJsonlSession(sessionsDir, 'project-a', 's1');
      writeJsonlSession(sessionsDir, 'project-b', 's2');
      fs.writeFileSync(path.join(sessionsDir, 'project-b', 'notes.txt'), 'not a session');

      assert.strictEqual(countSessionFiles(sessionsDir), 2);
    });

    it('needsBackfill is true when session file count exceeds indexed sessions', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      writeJsonlSession(sessionsDir, 'project-a', 's1');

      assert.strictEqual(needsBackfill(dbManager, sessionsDir, new Date('2026-05-03T01:00:00Z')), true);
    });

    it('needsBackfill is false when counts match and timestamp is recent', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      writeJsonlSession(sessionsDir, 'project-a', 's1');
      indexAllSessions(dbManager, sessionsDir);
      touchBackfillTimestamp(dbManager, new Date('2026-05-03T00:30:00Z'));

      assert.strictEqual(needsBackfill(dbManager, sessionsDir, new Date('2026-05-03T01:00:00Z')), false);
    });

    it('needsBackfill is true when file metadata changes even with a recent timestamp', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      writeJsonlSession(sessionsDir, 'project-a', 's1');
      indexAllSessions(dbManager, sessionsDir);
      touchBackfillTimestamp(dbManager, new Date('2026-05-03T00:30:00Z'));

      fs.appendFileSync(path.join(sessionsDir, 'project-a', 's1.jsonl'), '\n' + JSON.stringify({
        type: 'message',
        id: 's1-m2',
        parentId: null,
        timestamp: '2026-05-03T00:02:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello again' }], timestamp: Date.now() },
      }));

      assert.strictEqual(needsBackfill(dbManager, sessionsDir, new Date('2026-05-03T01:00:00Z')), true);
    });

    it('needsBackfill is true for existing sessions without file metadata even with a recent timestamp', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      writeJsonlSession(sessionsDir, 'project-a', 's1');
      indexSession(dbManager, createTestSession({ id: 's1', messages: [] }));
      touchBackfillTimestamp(dbManager, new Date('2026-05-03T00:30:00Z'));

      assert.strictEqual(needsBackfill(dbManager, sessionsDir, new Date('2026-05-03T01:00:00Z')), true);
    });

    it('needsBackfill is true when timestamp is missing or older than 24 hours', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      writeJsonlSession(sessionsDir, 'project-a', 's1');
      indexAllSessions(dbManager, sessionsDir);

      assert.strictEqual(needsBackfill(dbManager, sessionsDir, new Date('2026-05-03T01:00:00Z')), true);

      touchBackfillTimestamp(dbManager, new Date('2026-05-01T00:00:00Z'));
      assert.strictEqual(needsBackfill(dbManager, sessionsDir, new Date('2026-05-03T01:00:00Z')), true);
    });

    it('touchBackfillTimestamp upserts the metadata row', () => {
      touchBackfillTimestamp(dbManager, new Date('2026-05-03T00:00:00Z'));
      touchBackfillTimestamp(dbManager, new Date('2026-05-03T01:00:00Z'));

      const row = dbManager.getDb().prepare('SELECT value FROM extension_metadata WHERE key = ?').get(LAST_SESSION_BACKFILL_KEY) as { value: string };
      assert.strictEqual(row.value, '2026-05-03T01:00:00.000Z');
    });

    it('upsertSessionFileMetadata keeps stored metadata in sync after a session file is appended', () => {
      // Mirrors the session_shutdown path: index the session, then upsert the
      // file metadata for the final on-disk state. A subsequent
      // indexChangedSessions pass must skip the file instead of re-parsing it.
      const sessionsDir = path.join(tmpDir, 'sessions');
      writeJsonlSession(sessionsDir, 'project-a', 's1');
      const filePath = path.join(sessionsDir, 'project-a', 's1.jsonl');

      indexAllSessions(dbManager, sessionsDir);
      // Simulate Pi appending the closing entry on shutdown.
      fs.appendFileSync(filePath, '\n' + JSON.stringify({
        type: 'message',
        id: 's1-m2',
        parentId: null,
        timestamp: '2026-05-03T00:02:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello again' }], timestamp: Date.now() },
      }));
      const session = parseSessionFile(filePath);
      indexSession(dbManager, session);
      upsertSessionFileMetadata(dbManager, filePath, session.id);

      const result = indexChangedSessions(dbManager, sessionsDir);

      assert.strictEqual(result.sessionsProcessed, 0);
      assert.strictEqual(result.sessionsSkipped, 1);
      assert.strictEqual(result.reachedLimit, undefined);
    });
  });

  describe('getSessionStats', () => {
    it('should return zero counts for empty database', () => {
      const stats = getSessionStats(dbManager);
      assert.strictEqual(stats.totalSessions, 0);
      assert.strictEqual(stats.totalMessages, 0);
      assert.deepStrictEqual(stats.projects, []);
    });

    it('should return correct stats after indexing', () => {
      const session = createTestSession();
      indexSession(dbManager, session);

      const stats = getSessionStats(dbManager);
      assert.strictEqual(stats.totalSessions, 1);
      assert.strictEqual(stats.totalMessages, 2);
      assert.strictEqual(stats.projects.length, 1);
      assert.strictEqual(stats.projects[0].project, 'test-project');
      assert.strictEqual(stats.projects[0].sessions, 1);
      assert.strictEqual(stats.projects[0].messages, 2);
    });

    it('should group by project', () => {
      indexSession(dbManager, createTestSession({ id: 's1', project: 'project-a' }));
      indexSession(dbManager, createTestSession({ id: 's2', project: 'project-a' }));
      indexSession(dbManager, createTestSession({ id: 's3', project: 'project-b' }));

      const stats = getSessionStats(dbManager);
      assert.strictEqual(stats.totalSessions, 3);
      assert.strictEqual(stats.projects.length, 2);

      const projA = stats.projects.find(p => p.project === 'project-a');
      const projB = stats.projects.find(p => p.project === 'project-b');
      assert.ok(projA);
      assert.ok(projB);
      assert.strictEqual(projA.sessions, 2);
      assert.strictEqual(projB.sessions, 1);
    });
  });
});
