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
export function executeSearchWorker(request: SessionSearchWorkerRequest, onReady?: () => void): SessionSearchToolResult {
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
    onReady?.();
    if (request.mode === 'structured') return formatStructuredSearch(searchSessionEvidence(manager, request.query, request.options));
    const totalMessages = getIndexedMessageCount(manager);
    return formatLegacySearch(totalMessages || request.options.project ? searchSessions(manager, request.query, request.options) : [], totalMessages, request.query, request.snippetChars);
  } finally { db.close(); }
}

/** Wait only for ordinary coverage revalidation; repair work is never hidden or started here. */
export async function executeSearchWorkerWhenReady(request: SessionSearchWorkerRequest, onProgress?: (phase?: 'waiting_for_coverage') => void): Promise<SessionSearchToolResult> {
  let waiting = false;
  let identity: { dev: number; ino: number } | undefined;
  for (;;) {
    if (identity && request.mode !== 'anchors') {
      const current = statSync(request.dbPath);
      if (current.dev !== identity.dev || current.ino !== identity.ino) throw new SessionEvidenceUnavailableError();
    }
    try { return executeSearchWorker(request, () => { if (waiting) { waiting = false; onProgress?.(); } }); } catch (error) {
      if (!(error instanceof SessionEvidenceUnavailableError) || request.mode === 'anchors') throw error;
      const current = statSync(request.dbPath);
      identity ??= { dev: current.dev, ino: current.ino };
      const db = openReadOnly(request.dbPath);
      try {
        const row = db.prepare("SELECT value FROM extension_metadata WHERE key = 'session_repair_state:v1'").get() as { value?: unknown } | undefined;
        const state = parseSessionRepairState(row?.value);
        const schema = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
        if (state?.status === 'complete' && Number(schema?.user_version) === SESSION_REPAIR_VERSION) continue;
        if (!state || state.phase !== 'coverage' || !['pending', 'running'].includes(state.status) || Number(schema?.user_version) !== SESSION_REPAIR_VERSION) throw error;
      } catch { throw error; } finally { db.close(); }
      if (!waiting) { waiting = true; onProgress?.('waiting_for_coverage'); }
      // The parent's unchanged execution deadline and cancellation reap this child.
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
  }
}
