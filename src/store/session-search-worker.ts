import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
import { loadBetterSqlite3, isBunRuntime } from './sqlite-native.js';
import { SessionEvidenceUnavailableError, parseSessionRepairState, SESSION_REPAIR_VERSION, type DatabaseManager } from './db.js';
import { searchSessions, searchSessionEvidence, getIndexedMessageCount } from './session-search.js';
import { searchSessionAnchors } from './session-anchor-search.js';
import type { SessionSearchWorkerRequest } from './session-search-async.js';
import { formatLegacySearch, formatStructuredSearch, formatAnchorSearch, type SessionSearchToolResult } from './session-search-output.js';

type DatabaseLike = ReturnType<DatabaseManager['getDb']>;

/** Open a same-backend read-only connection, without schema setup or recovery. */
function openReadOnly(dbPath: string): DatabaseLike {
  if (isBunRuntime()) {
    const { Database } = createRequire(import.meta.url)('bun:sqlite') as { Database: new (file: string, options: { readonly: boolean; create: boolean }) => { query(sql: string): any; exec(sql: string): void; close(): void } };
    const db = new Database(dbPath, { readonly: true, create: false });
    db.exec('PRAGMA query_only=ON');
    return { prepare: (sql: string) => db.query(sql), close: () => db.close() } as DatabaseLike;
  }
  // Loading a search worker must never trigger a rebuild or write to the DB.
  const Database = loadBetterSqlite3({ allowRebuild: false });
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 1_000 }) as DatabaseLike;
  db.exec('PRAGMA query_only=ON');
  return db;
}

/** Run the ordinary search implementation in an isolated runtime, preserving its filters. */
export function executeSearchWorker(request: SessionSearchWorkerRequest): SessionSearchToolResult {
  if (request.mode === 'anchors') return formatAnchorSearch(searchSessionAnchors(request.markdown, { sessionsDir: request.sessionsDir }));
  try { statSync(request.dbPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Preserve first-use empty-index responses without creating a DB from search.
    return request.mode === 'legacy' ? formatLegacySearch([], 0, request.query, request.snippetChars) : formatStructuredSearch({ results: [], ambiguousSessionIds: [] });
  }
  const db = openReadOnly(request.dbPath);
  const manager = {
    getDb: () => db,
    assertSessionEvidenceAvailable() {
      // A partial schema cannot supply recognized durable state; do not repair it.
      const metadata = db.prepare("SELECT COUNT(*) AS columns FROM pragma_table_info('extension_metadata') WHERE name COLLATE NOCASE IN ('key', 'value')").get() as { columns?: number } | undefined;
      if (metadata?.columns !== 2) throw new SessionEvidenceUnavailableError();
      const row = db.prepare("SELECT value FROM extension_metadata WHERE key = 'session_repair_state:v1'").get() as { value?: unknown } | undefined;
      const state = parseSessionRepairState(row?.value);
      const schema = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
      // Unknown metadata is not proof of completed repair; search never repairs it.
      if (!state || state.status !== 'complete' || Number(schema?.user_version) !== SESSION_REPAIR_VERSION) throw new SessionEvidenceUnavailableError();
    },
  } as DatabaseManager;
  try {
    manager.assertSessionEvidenceAvailable();
    if (request.mode === 'structured') return formatStructuredSearch(searchSessionEvidence(manager, request.query, request.options));
    const totalMessages = getIndexedMessageCount(manager);
    return formatLegacySearch(totalMessages || request.options.project ? searchSessions(manager, request.query, request.options) : [], totalMessages, request.query, request.snippetChars);
  } finally { db.close(); }
}
