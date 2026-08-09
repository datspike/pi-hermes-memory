import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseManager } from './db.js';
import { parseSessionFile, parseSessionManagerSnapshot as parseCanonicalSnapshot, getSessionFiles, SessionFileTooLargeError, type ParsedSession } from './session-parser.js';

export const LAST_SESSION_BACKFILL_KEY = 'last_session_backfill';
export const SESSION_BACKFILL_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SESSION_BACKFILL_SCAN_CURSOR_KEY = 'session_backfill_scan_cursor:v1';
export const SESSION_BACKFILL_DEFERRED_KEY = 'session_backfill_deferred:v1';

/**
 * Index result for a single session.
 */
export interface IndexResult {
  sessionId: string;
  messagesIndexed: number;
  skipped: boolean; // true if the session already existed and no new messages were indexed
}

/**
 * Bulk index result.
 */
export interface BulkIndexResult {
  sessionsProcessed: number;
  sessionsIndexed: number;
  sessionsSkipped: number;
  messagesIndexed: number;
  errors: string[];
  reachedLimit?: boolean;
  partial?: boolean;
  aborted?: boolean;
  deferredFiles?: number;
  bytesScanned?: number;
}

interface SessionFileMetadata {
  path: string;
  size: number;
  mtimeMs: number;
}

/** Keep the derived index stable when the sessions root is addressed through a symlink. */
export function canonicalPath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export function containedCanonicalPath(sessionsDir: string | undefined, candidate: string): string | null {
  let root: string;
  let real: string;
  try {
    root = fs.realpathSync.native(sessionsDir ?? path.dirname(candidate));
    real = fs.realpathSync.native(candidate);
  } catch {
    return null;
  }
  const relative = path.relative(root, real);
  if (relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) return null;
  return real;
}

export function canonicalSessionOwners(db: ReturnType<DatabaseManager['getDb']>, sessionId: string, sessionsDir?: string): Array<{ path: string; session: ParsedSession }> {
  const owners = db.prepare('SELECT path, indexed_at FROM session_files WHERE session_id = ? ORDER BY indexed_at DESC, path DESC').all(sessionId) as Array<{ path: string; indexed_at: string }>;
  const valid: Array<{ path: string; session: ParsedSession; indexedAt: string }> = [];
  for (const owner of owners) {
    const contained = containedCanonicalPath(sessionsDir, owner.path);
    if (!contained) continue;
    try {
      const session = parseSessionFile(contained);
      if (session?.id === sessionId) valid.push({ path: contained, session, indexedAt: owner.indexed_at });
    } catch { /* invalid JSONL is not canonical evidence */ }
  }
  return valid
    .sort((a, b) => b.indexedAt.localeCompare(a.indexedAt) || b.path.localeCompare(a.path))
    .map(({ path: ownerPath, session }) => ({ path: ownerPath, session }));
}

function getCanonicalSessionFiles(sessionsDir: string, projectDir?: string): string[] {
  const root = canonicalPath(sessionsDir);
  const requested = projectDir ? path.resolve(root, projectDir) : root;
  const relative = path.relative(root, requested);
  if (relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) return [];
  return getSessionFiles(root, projectDir).map(canonicalPath);
}

export interface IncrementalIndexOptions {
  projectDir?: string;
  maxFilesToIndex?: number;
}

export interface BoundedBackfillOptions extends IncrementalIndexOptions {
  signal?: AbortSignal;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxDurationMs?: number;
  yieldFn?: () => Promise<void>;
}

export const BACKFILL_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const BACKFILL_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const BACKFILL_MAX_DURATION_MS = 250;

const macrotaskYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Test-only failure seam. The callback runs after each mutating statement. */
export type IndexerFaultInjector = (statement: string) => void;
let faultInjector: IndexerFaultInjector | undefined;

export function setSessionIndexerFaultInjector(injector?: IndexerFaultInjector): void {
  faultInjector = injector;
}

function runStatement<T>(statement: string, action: () => T): T {
  const result = action();
  faultInjector?.(statement);
  return result;
}

function storageId(sessionId: string, entryId: string): string {
  return `idx:v1:${createHash('sha256').update(JSON.stringify({ v: 1, sessionId, entryId })).digest('hex').slice(0, 32)}`;
}

function canonicalEntries(session: ParsedSession): ParsedSession['messages'] {
  const counts = new Map<string, number>();
  for (const message of session.messages) {
    const logicalId = message.entryId ?? message.id;
    if (logicalId) counts.set(logicalId, (counts.get(logicalId) ?? 0) + 1);
  }
  return session.messages.filter((message) => {
    const logicalId = message.entryId ?? message.id;
    return Boolean(logicalId)
      && (counts.get(logicalId as string) ?? 0) === 1
      && message.identityStatus !== 'ambiguous'
      && message.identityStatus !== 'unresolvable';
  });
}

function entryId(message: ParsedSession['messages'][number]): string {
  return message.entryId ?? message.id;
}

function writeSessionMetadata(db: ReturnType<DatabaseManager['getDb']>, session: ParsedSession): void {
  runStatement('insert-session', () => db.prepare(`
    INSERT INTO sessions (id, project, cwd, started_at, ended_at, message_count, name, title)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project = excluded.project,
      cwd = excluded.cwd,
      started_at = excluded.started_at,
      ended_at = COALESCE(excluded.ended_at, sessions.ended_at),
      name = excluded.name,
      title = excluded.title
  `).run(session.id, session.project, session.cwd, session.startedAt, session.endedAt, session.name ?? null, session.title ?? null));
}

function writeMessages(db: ReturnType<DatabaseManager['getDb']>, session: ParsedSession, messages: ParsedSession['messages']): void {
  const insert = db.prepare(`
    INSERT INTO messages (id, session_id, entry_id, role, kind, parent_entry_id, ordinal, content, timestamp, tool_calls, tool_name, tool_call_id, diagnostics)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET
      id = excluded.id,
      role = excluded.role,
      kind = excluded.kind,
      parent_entry_id = excluded.parent_entry_id,
      ordinal = excluded.ordinal,
      content = excluded.content,
      timestamp = excluded.timestamp,
      tool_calls = excluded.tool_calls,
      tool_name = excluded.tool_name,
      tool_call_id = excluded.tool_call_id,
      diagnostics = excluded.diagnostics
  `);
  for (const message of messages) {
    const logicalId = entryId(message);
    runStatement('upsert-message', () => insert.run(
      storageId(session.id, logicalId),
      session.id,
      logicalId,
      message.role,
      message.kind ?? 'message',
      message.parentEntryId ?? null,
      message.ordinal ?? 0,
      message.content,
      message.timestamp,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.toolName ?? null,
      message.toolCallId ?? null,
      message.diagnostics?.length ? JSON.stringify(message.diagnostics) : null,
    ));
  }
}

function reconcileSession(db: ReturnType<DatabaseManager['getDb']>, sessionId: string, authoritativeIds: Set<string>): void {
  const ambiguous = db.prepare("DELETE FROM messages WHERE session_id = ? AND (entry_id IS NULL OR diagnostics LIKE '%ambiguous-entry-id%')");
  runStatement('delete-unresolvable-message', () => ambiguous.run(sessionId));
  const rows = db.prepare('SELECT entry_id FROM messages WHERE session_id = ? AND entry_id IS NOT NULL').all(sessionId) as Array<{ entry_id: string }>;
  const remove = db.prepare('DELETE FROM messages WHERE session_id = ? AND entry_id = ?');
  for (const row of rows) {
    if (!authoritativeIds.has(row.entry_id)) runStatement('delete-stale-message', () => remove.run(sessionId, row.entry_id));
  }
  runStatement('update-session-count', () => db.prepare('UPDATE sessions SET message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?) WHERE id = ?').run(sessionId, sessionId));
}

function linkedCanonicalIds(db: ReturnType<DatabaseManager['getDb']>, sessionId: string, currentPath: string, currentSession: ParsedSession): Set<string> {
  const ids = new Set(canonicalEntries(currentSession).map(entryId));
  const paths = db.prepare('SELECT path FROM session_files WHERE session_id = ? AND path <> ?').all(sessionId, currentPath) as Array<{ path: string }>;
  for (const { path } of paths) {
    if (!fs.existsSync(path)) continue;
    const linked = parseSessionFile(path);
    if (linked?.id !== sessionId) continue;
    for (const message of canonicalEntries(linked)) ids.add(entryId(message));
  }
  return ids;
}

function remainingCanonicalIds(db: ReturnType<DatabaseManager['getDb']>, sessionId: string): Set<string> {
  const ids = new Set<string>();
  const paths = db.prepare('SELECT path FROM session_files WHERE session_id = ?').all(sessionId) as Array<{ path: string }>;
  for (const { path } of paths) {
    if (!fs.existsSync(path)) continue;
    const linked = parseSessionFile(path);
    if (linked?.id !== sessionId) continue;
    for (const message of canonicalEntries(linked)) ids.add(entryId(message));
  }
  return ids;
}

function purgeSessionIfUnowned(db: ReturnType<DatabaseManager['getDb']>, sessionId: string): void {
  if (db.prepare('SELECT 1 FROM session_files WHERE session_id = ? LIMIT 1').get(sessionId)) {
    reconcileSession(db, sessionId, remainingCanonicalIds(db, sessionId));
    return;
  }
  runStatement('delete-session-messages', () => db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId));
  runStatement('delete-session', () => db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId));
}

/** Remove one missing canonical owner without purging a session that still has linked paths. */
export function removeMissingCanonicalFile(dbManager: DatabaseManager, filePath: string): void {
  dbManager.withCorruptionRecovery(() => {
    const db = dbManager.getDb();
    const owner = db.prepare('SELECT session_id FROM session_files WHERE path = ?').get(filePath) as { session_id: string } | undefined;
    if (!owner) return;
    const work = () => {
      runStatement('delete-missing-session-file', () => db.prepare('DELETE FROM session_files WHERE path = ?').run(filePath));
      purgeSessionIfUnowned(db, owner.session_id);
    };
    if (db.transaction) db.transaction(work)();
    else { db.exec('BEGIN IMMEDIATE'); try { work(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } }
  });
}

/**
 * Index a parsed snapshot. Snapshots are additive and non-authoritative: an
 * absent entry is never deleted because the live SessionManager is partial.
 */
export function indexSession(dbManager: DatabaseManager, session: ParsedSession): IndexResult {
  return dbManager.withCorruptionRecovery(() => indexSessionOnce(dbManager, session));
}

function indexSessionOnce(dbManager: DatabaseManager, session: ParsedSession): IndexResult {
  const db = dbManager.getDb();
  const before = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(session.id) as { count: number };
  const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id);
  const messages = canonicalEntries(session);
  const work = () => {
    writeSessionMetadata(db, session);
    writeMessages(db, session, messages);
    runStatement('update-session-count', () => db.prepare('UPDATE sessions SET message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?) WHERE id = ?').run(session.id, session.id));
  };
  if (db.transaction) db.transaction(work)();
  else { db.exec('BEGIN IMMEDIATE'); try { work(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } }
  const after = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(session.id) as { count: number };
  return { sessionId: session.id, messagesIndexed: after.count - before.count, skipped: Boolean(existing) && after.count === before.count };
}

function indexCanonicalSessionFileOnce(dbManager: DatabaseManager, file: string, session: ParsedSession): IndexResult {
  file = canonicalPath(file);
  const db = dbManager.getDb();
  const metadata = getSessionFileMetadata(file);
  const oldOwner = db.prepare('SELECT session_id FROM session_files WHERE path = ?').get(file) as { session_id: string } | undefined;
  const before = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(session.id) as { count: number };
  const work = () => {
    writeSessionMetadata(db, session);
    writeMessages(db, session, canonicalEntries(session));
    runStatement('upsert-session-file', () => db.prepare(`
      INSERT INTO session_files (path, session_id, size, mtime_ms, indexed_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET session_id = excluded.session_id, size = excluded.size, mtime_ms = excluded.mtime_ms, indexed_at = excluded.indexed_at
    `).run(file, session.id, metadata.size, metadata.mtimeMs, new Date().toISOString()));
    reconcileSession(db, session.id, linkedCanonicalIds(db, session.id, file, session));
    if (oldOwner && oldOwner.session_id !== session.id) purgeSessionIfUnowned(db, oldOwner.session_id);
  };
  if (db.transaction) db.transaction(work)();
  else { db.exec('BEGIN IMMEDIATE'); try { work(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } }
  const after = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(session.id) as { count: number };
  return { sessionId: session.id, messagesIndexed: after.count - before.count, skipped: Boolean(oldOwner?.session_id === session.id) && after.count === before.count };
}

function indexCanonicalSessionFile(dbManager: DatabaseManager, file: string, session: ParsedSession): IndexResult {
  return dbManager.withCorruptionRecovery(() => indexCanonicalSessionFileOnce(dbManager, file, session));
}

type SessionManagerSnapshot = {
  getHeader: () => { id: string; timestamp: string; cwd: string } | null;
  getEntries: () => unknown[];
  getSessionFile?: () => string | undefined;
};

type SessionMessageEntryLike = {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
};

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;

    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string') parts.push(b.text);
        break;
      case 'tool_result':
        if (typeof b.content === 'string') {
          parts.push(b.content);
        } else if (Array.isArray(b.content)) {
          for (const item of b.content) {
            if (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'text') {
              const text = (item as Record<string, unknown>).text;
              if (typeof text === 'string') parts.push(text);
            }
          }
        }
        break;
    }
  }

  return parts.join('\n').trim();
}

function extractToolCalls(content: unknown): string[] | undefined {
  if (!Array.isArray(content)) return undefined;

  const toolNames: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if ((b.type === 'toolCall' || b.type === 'tool_use') && typeof b.name === 'string') {
      toolNames.push(b.name);
    }
  }
  return toolNames.length > 0 ? toolNames : undefined;
}

function parseMessageEntry(entry: unknown): ParsedSession['messages'][number] | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as SessionMessageEntryLike;
  if (e.type !== 'message' || typeof e.id !== 'string' || typeof e.timestamp !== 'string' || !e.message) return null;

  const role = e.message.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'system') return null;

  const content = extractTextContent(e.message.content);
  if (!content) return null;

  return {
    id: e.id,
    role,
    content,
    timestamp: e.timestamp,
    toolCalls: role === 'assistant' ? extractToolCalls(e.message.content) : undefined,
  };
}

export function parseSessionManagerSnapshot(sessionManager: SessionManagerSnapshot): ParsedSession | null {
  return parseCanonicalSnapshot(sessionManager);
}

export function indexCurrentSession(dbManager: DatabaseManager, sessionManager: SessionManagerSnapshot): IndexResult | null {
  const session = parseSessionManagerSnapshot(sessionManager);
  if (!session) return null;
  return indexSession(dbManager, session);
}

export function indexLiveSession(dbManager: DatabaseManager, sessionManager: SessionManagerSnapshot, sessionsDir?: string): IndexResult | null {
  return dbManager.withCorruptionRecovery(() => indexLiveSessionOnce(dbManager, sessionManager, sessionsDir));
}

function indexLiveSessionOnce(dbManager: DatabaseManager, sessionManager: SessionManagerSnapshot, sessionsDir?: string): IndexResult | null {
  const sessionFile = sessionManager.getSessionFile?.();
  if (sessionFile) {
    const contained = sessionsDir ? containedCanonicalPath(sessionsDir, sessionFile) : canonicalPath(sessionFile);
    const canonicalFile = contained ?? '';
    if (canonicalFile && fs.existsSync(canonicalFile)) {
      const session = parseSessionFile(canonicalFile);
      if (session) return indexCanonicalSessionFile(dbManager, canonicalFile, session);
    }
  }

  return indexCurrentSession(dbManager, sessionManager);
}

function getSessionFileMetadata(filePath: string): SessionFileMetadata {
  const stat = fs.statSync(filePath);
  return { path: filePath, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
}

function getStoredSessionFileMetadata(dbManager: DatabaseManager, filePath: string): { size: number; mtime_ms: number } | undefined {
  return dbManager.getDb().prepare('SELECT size, mtime_ms FROM session_files WHERE path = ?').get(filePath) as { size: number; mtime_ms: number } | undefined;
}

function storedSessionFileMatches(dbManager: DatabaseManager, metadata: SessionFileMetadata): boolean {
  const row = getStoredSessionFileMetadata(dbManager, metadata.path);
  return Boolean(row && row.size === metadata.size && row.mtime_ms === metadata.mtimeMs);
}

export function upsertSessionFileMetadata(
  dbManager: DatabaseManager,
  filePath: string,
  sessionId: string,
  metadata = getSessionFileMetadata(filePath),
  indexedAt = new Date(),
): void {
  const db = dbManager.getDb();
  filePath = canonicalPath(filePath);
  db.prepare(`
    INSERT INTO session_files (path, session_id, size, mtime_ms, indexed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      session_id = excluded.session_id,
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      indexed_at = excluded.indexed_at
  `).run(metadata.path, sessionId, metadata.size, metadata.mtimeMs, indexedAt.toISOString());
}

function emptyBulkIndexResult(): BulkIndexResult {
  return {
    sessionsProcessed: 0,
    sessionsIndexed: 0,
    sessionsSkipped: 0,
    messagesIndexed: 0,
    errors: [],
  };
}

function indexSessionFile(dbManager: DatabaseManager, file: string, result: BulkIndexResult, maxFileBytes?: number): void {
  result.sessionsProcessed++;

  const session = parseSessionFile(file, maxFileBytes);
  if (!session) {
    result.errors.push(`Failed to parse: ${file}`);
    return;
  }

  const indexResult = indexCanonicalSessionFile(dbManager, file, session);
  if (indexResult.skipped) {
    result.sessionsSkipped++;
  } else {
    result.sessionsIndexed++;
    result.messagesIndexed += indexResult.messagesIndexed;
  }
}

function removeMissingCanonicalFiles(dbManager: DatabaseManager, knownFiles: readonly string[], scopeRoot: string): void {
  const db = dbManager.getDb();
  const known = new Set(knownFiles);
  const rows = db.prepare('SELECT path, session_id FROM session_files').all() as Array<{ path: string; session_id: string }>;
  const prefix = scopeRoot.endsWith(path.sep) ? scopeRoot : `${scopeRoot}${path.sep}`;
  for (const row of rows) {
    if (!row.path.startsWith(prefix) || known.has(row.path)) continue;
    const work = () => {
      runStatement('delete-missing-session-file', () => db.prepare('DELETE FROM session_files WHERE path = ?').run(row.path));
      purgeSessionIfUnowned(db, row.session_id);
    };
    if (db.transaction) db.transaction(work)();
    else { db.exec('BEGIN IMMEDIATE'); try { work(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } }
  }
}

/**
 * Index all sessions from disk.
 *
 * @param dbManager — Database manager instance
 * @param sessionsDir — Path to ~/.pi/agent/sessions/
 * @param projectDir — Optional: specific project directory to index
 * @returns Bulk index result
 */
export function indexAllSessions(
  dbManager: DatabaseManager,
  sessionsDir: string,
  projectDir?: string
): BulkIndexResult {
  const files = getCanonicalSessionFiles(sessionsDir, projectDir);
  const result = emptyBulkIndexResult();

  for (const file of files) {
    try {
      indexSessionFile(dbManager, file, result);
    } catch (err) {
      result.errors.push(`Error indexing ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    const scopeRoot = canonicalPath(sessionsDir);
    const requestedRoot = projectDir ? path.resolve(scopeRoot, projectDir) : scopeRoot;
    const relative = path.relative(scopeRoot, requestedRoot);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('session project path escapes sessions directory');
    removeMissingCanonicalFiles(dbManager, files, requestedRoot);
  } catch (err) {
    result.errors.push(`Error cleaning missing session files: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

/**
 * Incrementally index session JSONL files without matching stored metadata.
 *
 * This is intentionally cheaper than indexAllSessions() for startup backfill:
 * files with matching stored size/mtime metadata are skipped, and all other
 * files are parsed under the startup cap.
 */
export function indexChangedSessions(
  dbManager: DatabaseManager,
  sessionsDir: string,
  options: IncrementalIndexOptions = {},
): BulkIndexResult {
  const files = getCanonicalSessionFiles(sessionsDir, options.projectDir);
  const maxFilesToIndex = options.maxFilesToIndex ?? 50;
  const result = emptyBulkIndexResult();

  // Gather the changed set first, then sort newest-first before applying the
  // cap. Crash recovery is the primary value of startup backfill (the live
  // message_end path missed the session's final state), and crashed sessions
  // are the most recently modified files. Sorting newest-first ensures they
  // are indexed on the very next startup instead of waiting behind old
  // historical files that fill the per-startup cap in filesystem order.
  const changed: SessionFileMetadata[] = [];
  for (const file of files) {
    try {
      const metadata = getSessionFileMetadata(file);
      if (storedSessionFileMatches(dbManager, metadata)) {
        result.sessionsSkipped++;
        continue;
      }
      changed.push(metadata);
    } catch (err) {
      result.errors.push(`Error indexing ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  changed.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const metadata of changed) {
    if (result.sessionsProcessed >= maxFilesToIndex) {
      result.reachedLimit = true;
      break;
    }
    try {
      indexSessionFile(dbManager, metadata.path, result);
    } catch (err) {
      result.errors.push(`Error indexing ${metadata.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

interface DeferredFingerprint {
  size: number;
  mtimeMs: number;
}

type DeferredFingerprints = Record<string, DeferredFingerprint>;

function readMetadataValue(dbManager: DatabaseManager, key: string): string | null {
  const row = dbManager.getDb().prepare('SELECT value FROM extension_metadata WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function writeMetadataValue(dbManager: DatabaseManager, key: string, value: string | null): void {
  const db = dbManager.getDb();
  const work = () => {
    if (value === null) db.prepare('DELETE FROM extension_metadata WHERE key = ?').run(key);
    else db.prepare(`
      INSERT INTO extension_metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  };
  if (db.transaction) db.transaction(work)();
  else { db.exec('BEGIN IMMEDIATE'); try { work(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } }
}

function getScanCursor(dbManager: DatabaseManager): string | null {
  return readMetadataValue(dbManager, SESSION_BACKFILL_SCAN_CURSOR_KEY);
}

function setScanCursor(dbManager: DatabaseManager, filePath: string): void {
  writeMetadataValue(dbManager, SESSION_BACKFILL_SCAN_CURSOR_KEY, filePath);
}

function getDeferredFingerprints(dbManager: DatabaseManager): DeferredFingerprints {
  const value = readMetadataValue(dbManager, SESSION_BACKFILL_DEFERRED_KEY);
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, DeferredFingerprint>;
    return Object.fromEntries(Object.entries(parsed).filter(([, fingerprint]) => (
      fingerprint && Number.isFinite(fingerprint.size) && Number.isFinite(fingerprint.mtimeMs)
    )));
  } catch {
    return {};
  }
}

function setDeferredFingerprints(dbManager: DatabaseManager, fingerprints: DeferredFingerprints): void {
  writeMetadataValue(dbManager, SESSION_BACKFILL_DEFERRED_KEY, Object.keys(fingerprints).length ? JSON.stringify(fingerprints) : null);
}

async function discoverCanonicalSessionFiles(
  sessionsDir: string,
  projectDir: string | undefined,
  signal: AbortSignal | undefined,
  deadline: number,
  yieldFn: () => Promise<void>,
  onFileDiscovered: (filePath: string) => void,
  cursor: string | null,
): Promise<{ files: string[]; complete: boolean }> {
  const sessionsRoot = canonicalPath(sessionsDir);
  const root = projectDir ? path.resolve(sessionsRoot, projectDir) : sessionsRoot;
  const relative = path.relative(sessionsRoot, root);
  if (relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) return { files: [], complete: true };
  const files: string[] = [];
  let complete = true;
  let passedCursor = cursor === null;
  let cursorSeen = cursor === null;
  const emit = (filePath: string): void => {
    if (!passedCursor) {
      if (filePath <= (cursor as string)) return;
      passedCursor = true;
    }
    cursorSeen = cursorSeen || filePath === cursor;
    files.push(filePath);
    onFileDiscovered(filePath);
  };
  const checkBudget = (): boolean => {
    if (signal?.aborted || Date.now() >= deadline) {
      complete = false;
      return false;
    }
    return true;
  };
  try {
    const entries = (await fs.promises.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!checkBudget()) break;
      const candidate = path.join(root, entry.name);
      if (!projectDir && !passedCursor && cursor && entry.isDirectory() && candidate < path.dirname(cursor)) {
        await yieldFn();
        continue;
      }
      const stat = await fs.promises.stat(candidate);
      if (stat.isDirectory() && !projectDir) {
        const children = (await fs.promises.readdir(candidate, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
          if (!checkBudget()) break;
          const childPath = path.join(candidate, child.name);
          if (!passedCursor && cursor && childPath <= cursor) {
            await yieldFn();
            continue;
          }
          if (child.name.endsWith('.jsonl')) {
            if ((await fs.promises.stat(childPath)).isFile()) {
              const canonical = canonicalPath(childPath);
              const childRelative = path.relative(sessionsRoot, canonical);
              if (childRelative === '..' || childRelative.startsWith(`..${path.sep}`) || path.isAbsolute(childRelative)) continue;
              emit(canonical);
            }
          }
          await yieldFn();
        }
      } else if (stat.isFile() && entry.name.endsWith('.jsonl')) {
        const canonical = canonicalPath(candidate);
        const fileRelative = path.relative(sessionsRoot, canonical);
        if (fileRelative === '..' || fileRelative.startsWith(`..${path.sep}`) || path.isAbsolute(fileRelative)) continue;
        emit(canonical);
      }
      await yieldFn();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (complete && cursor !== null && !passedCursor && !cursorSeen) {
    // The persisted owner disappeared or the tree was replaced. Start a new
    // cycle rather than permanently skipping every path lexically before it.
    return discoverCanonicalSessionFiles(sessionsDir, projectDir, signal, deadline, yieldFn, onFileDiscovered, null);
  }
  return { files: [...new Set(files)].sort(), complete };
}

/**
 * Async startup backfill with explicit file, byte, wall-clock and cursor budgets.
 * Manual indexAllSessions remains the unbounded operator path.
 */
export async function indexChangedSessionsBounded(
  dbManager: DatabaseManager,
  sessionsDir: string,
  options: BoundedBackfillOptions = {},
): Promise<BulkIndexResult> {
  const maxFilesToIndex = options.maxFilesToIndex ?? 50;
  const maxFileBytes = options.maxFileBytes ?? BACKFILL_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? BACKFILL_MAX_TOTAL_BYTES;
  const maxDurationMs = options.maxDurationMs ?? BACKFILL_MAX_DURATION_MS;
  const yieldFn = options.yieldFn ?? macrotaskYield;
  const deadline = Date.now() + maxDurationMs;
  const result = emptyBulkIndexResult();
  if (options.signal?.aborted) return { ...result, partial: true, aborted: true };
  const cursor = getScanCursor(dbManager);
  const discovery = await discoverCanonicalSessionFiles(sessionsDir, options.projectDir, options.signal, deadline, yieldFn, (file) => {
    if (!options.signal?.aborted) setScanCursor(dbManager, file);
  }, null);
  if (!discovery.complete) {
    result.partial = true;
    result.aborted = options.signal?.aborted;
  }
  if (options.signal?.aborted) return { ...result, partial: true, aborted: true };
  const files = discovery.files;
  const cursorIndex = cursor ? files.findIndex((file) => file > cursor) : 0;
  const orderedFiles = cursorIndex > 0 ? [...files.slice(cursorIndex), ...files.slice(0, cursorIndex)] : files;
  const deferred = getDeferredFingerprints(dbManager);
  const changed: SessionFileMetadata[] = [];

  for (const file of orderedFiles) {
    if (options.signal?.aborted || Date.now() >= deadline) {
      result.partial = true;
      result.aborted = options.signal?.aborted;
      break;
    }
    try {
      const stat = await fs.promises.stat(file);
      const metadata = { path: file, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
      const previous = deferred[file];
      if (previous && previous.size === metadata.size && previous.mtimeMs === metadata.mtimeMs) {
        result.deferredFiles = (result.deferredFiles ?? 0) + 1;
      } else if (storedSessionFileMatches(dbManager, metadata)) {
        result.sessionsSkipped++;
        if (previous) delete deferred[file];
      } else {
        changed.push(metadata);
      }
    } catch (error) {
      result.errors.push(`Error indexing ${file}: ${error instanceof Error ? error.message : String(error)}`);
      result.partial = true;
    } finally {
      if (!options.signal?.aborted) setScanCursor(dbManager, file);
    }
    await yieldFn();
    if (options.signal?.aborted) return { ...result, partial: true, aborted: true };
  }

  const discoveryComplete = discovery.complete;
  if (discoveryComplete && !options.signal?.aborted) {
    for (const file of Object.keys(deferred)) if (!files.includes(file)) delete deferred[file];
  }

  // Newest files get priority for crash recovery. Malformed candidates do not
  // consume the successful-file cap, so one bad file cannot starve the tail.
  changed.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const metadata of changed) {
    if (options.signal?.aborted || Date.now() >= deadline || result.sessionsProcessed >= maxFilesToIndex) {
      result.partial = true;
      result.aborted = options.signal?.aborted;
      result.reachedLimit = result.sessionsProcessed >= maxFilesToIndex;
      break;
    }
    if (metadata.size > maxFileBytes || (result.bytesScanned ?? 0) + metadata.size > maxTotalBytes) {
      result.deferredFiles = (result.deferredFiles ?? 0) + 1;
      deferred[metadata.path] = { size: metadata.size, mtimeMs: metadata.mtimeMs };
      result.partial = true;
      await yieldFn();
      continue;
    }
    try {
      const session = parseSessionFile(metadata.path, maxFileBytes);
      const finalMetadata = getSessionFileMetadata(metadata.path);
      if (finalMetadata.size > maxFileBytes || (result.bytesScanned ?? 0) + finalMetadata.size > maxTotalBytes) {
        result.deferredFiles = (result.deferredFiles ?? 0) + 1;
        deferred[metadata.path] = { size: finalMetadata.size, mtimeMs: finalMetadata.mtimeMs };
        result.partial = true;
      } else if (session) {
        result.sessionsProcessed++;
        const indexResult = indexCanonicalSessionFile(dbManager, metadata.path, session);
        if (indexResult.skipped) result.sessionsSkipped++;
        else {
          result.sessionsIndexed++;
          result.messagesIndexed += indexResult.messagesIndexed;
        }
        result.bytesScanned = (result.bytesScanned ?? 0) + finalMetadata.size;
        delete deferred[metadata.path];
      } else {
        result.errors.push(`Failed to parse: ${metadata.path}`);
      }
    } catch (error) {
      if (error instanceof SessionFileTooLargeError) {
        result.deferredFiles = (result.deferredFiles ?? 0) + 1;
        const current = getSessionFileMetadata(metadata.path);
        deferred[metadata.path] = { size: current.size, mtimeMs: current.mtimeMs };
      } else {
        result.errors.push(`Error indexing ${metadata.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      result.partial = true;
    }
    if (!options.signal?.aborted) setScanCursor(dbManager, metadata.path);
    await yieldFn();
    if (options.signal?.aborted) return { ...result, partial: true, aborted: true };
  }

  const attemptedAll = changed.length <= result.sessionsProcessed + (result.deferredFiles ?? 0) && !result.reachedLimit && !result.aborted && Date.now() < deadline;
  if (discoveryComplete && attemptedAll && !options.signal?.aborted) writeMetadataValue(dbManager, SESSION_BACKFILL_SCAN_CURSOR_KEY, null);
  if (discoveryComplete && !options.signal?.aborted) {
    try { removeMissingCanonicalFiles(dbManager, files, canonicalPath(sessionsDir)); }
    catch (error) { result.errors.push(`Error cleaning missing session files: ${error instanceof Error ? error.message : String(error)}`); result.partial = true; }
  }
  if (changed.length > result.sessionsProcessed + (result.deferredFiles ?? 0) && !result.reachedLimit && !result.aborted) result.partial = true;
  if (Object.keys(deferred).length > 0) result.partial = true;
  if (options.signal?.aborted) return { ...result, partial: true, aborted: true };
  setDeferredFingerprints(dbManager, deferred);
  return result;
}

/** Startup always schedules a deferred metadata discovery; the watermark is not an eligibility gate. */
export function needsBackfillQuick(_dbManager: DatabaseManager, _now = new Date()): boolean {
  return true;
}

/**
 * Cheaply count session JSONL files in the same scope indexAllSessions scans.
 */
export function countSessionFiles(sessionsDir: string): number {
  return getCanonicalSessionFiles(sessionsDir).length;
}

function getLastBackfillTimestamp(dbManager: DatabaseManager): string | null {
  const db = dbManager.getDb();
  const row = db.prepare('SELECT value FROM extension_metadata WHERE key = ?').get(LAST_SESSION_BACKFILL_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

function isRecentBackfillTimestamp(value: string | null, nowMs: number): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return nowMs - parsed < SESSION_BACKFILL_INTERVAL_MS;
}

/**
 * Determine whether a background session backfill should run.
 *
 * The check stays cheap: it compares file counts and stored file size/mtime
 * metadata. Full JSONL parsing is left to the scheduled incremental backfill.
 */
export function needsBackfill(dbManager: DatabaseManager, sessionsDir: string, now = new Date()): boolean {
  const db = dbManager.getDb();
  const files = getSessionFiles(sessionsDir);
  const indexed = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };

  if (files.length > indexed.count) {
    return true;
  }

  for (const file of files) {
    try {
      const metadata = getSessionFileMetadata(file);
      if (storedSessionFileMatches(dbManager, metadata)) continue;
      return true;
    } catch {
      return true;
    }
  }

  return !isRecentBackfillTimestamp(getLastBackfillTimestamp(dbManager), now.getTime());
}

/**
 * Record a successful session backfill completion timestamp.
 */
export function touchBackfillTimestamp(dbManager: DatabaseManager, timestamp = new Date()): void {
  const db = dbManager.getDb();
  db.prepare(`
    INSERT INTO extension_metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(LAST_SESSION_BACKFILL_KEY, timestamp.toISOString());
}

/**
 * Get statistics about indexed sessions.
 */
export function getSessionStats(dbManager: DatabaseManager): {
  totalSessions: number;
  totalMessages: number;
  projects: { project: string; sessions: number; messages: number }[];
} {
  const db = dbManager.getDb();

  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM sessions) as sessions,
      (SELECT COUNT(*) FROM messages) as messages
  `).get() as { sessions: number; messages: number };

  const projects = db.prepare(`
    SELECT
      project,
      COUNT(*) as sessions,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id IN (SELECT id FROM sessions s2 WHERE s2.project = s.project)) as messages
    FROM sessions s
    GROUP BY project
    ORDER BY sessions DESC
  `).all() as { project: string; sessions: number; messages: number }[];

  return {
    totalSessions: totals.sessions,
    totalMessages: totals.messages,
    projects,
  };
}
