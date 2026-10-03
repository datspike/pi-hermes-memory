import fs from 'node:fs';
import { DEFAULT_MAX_MESSAGE_CONTENT_LENGTH } from '../constants.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseManager } from './db.js';
import { parseSessionFile, parseSessionManagerSnapshot as parseCanonicalSnapshot, getSessionFiles, SessionFileTooLargeError, SessionSearchReadLimitError, type ParsedSession } from './session-parser.js';

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
  /** Session files skipped because their mtime is outside the retention window. */
  expiredSkipped?: number;
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

/** Contain a resolved real path under an already-pinned root. */
function containedUnderRoot(root: string, candidate: string): string | null {
  let real: string;
  try {
    real = fs.realpathSync.native(candidate);
  } catch {
    return null;
  }
  const relative = path.relative(root, real);
  if (relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) return null;
  return real;
}

export function containedCanonicalPath(sessionsDir: string | undefined, candidate: string): string | null {
  try {
    return containedUnderRoot(fs.realpathSync.native(sessionsDir ?? path.dirname(candidate)), candidate);
  } catch {
    return null;
  }
}

/** A directory identity pinned independently from its mutable pathname. */
export interface PinnedSessionRoot {
  root: string;
  fd: number;
  dev: bigint;
  ino: bigint;
}

function sameDirectoryIdentity(stat: { dev: bigint; ino: bigint }, root: PinnedSessionRoot): boolean {
  return stat.dev === root.dev && stat.ino === root.ino;
}

export function openPinnedSessionRoot(root: string): PinnedSessionRoot | null {
  let fd: number | undefined;
  try {
    // The configured root may itself be a symlink; the returned descriptor pins its target.
    fd = fs.openSync(root, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isDirectory()) { fs.closeSync(fd); return null; }
    const canonicalRoot = process.platform === 'linux' ? fs.realpathSync.native(`/proc/self/fd/${fd}`) : fs.realpathSync.native(root);
    return { root: canonicalRoot, fd, dev: stat.dev, ino: stat.ino };
  } catch {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best effort */ } }
    return null;
  }
}

export function closePinnedSessionRoot(root: PinnedSessionRoot): void {
  try { fs.closeSync(root.fd); } catch { /* best effort */ }
}

function currentPathMatchesRoot(root: PinnedSessionRoot): boolean {
  try {
    const stat = fs.statSync(root.root, { bigint: true });
    return sameDirectoryIdentity(stat, root);
  } catch {
    return false;
  }
}

function openRelativeSessionFile(root: PinnedSessionRoot, filePath: string): { fd: number; directoryFds: number[] } | null {
  const relative = path.relative(root.root, filePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  const components = relative.split(path.sep);
  if (components.some((component) => !component || component === '.' || component === '..')) return null;
  const directoryFds: number[] = [];
  let directoryFd = root.fd;
  const directoryFlags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  const fileFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  try {
    for (const component of components.slice(0, -1)) {
      const next = fs.openSync(`/proc/self/fd/${directoryFd}/${component}`, directoryFlags);
      directoryFds.push(next);
      directoryFd = next;
    }
    const fd = fs.openSync(`/proc/self/fd/${directoryFd}/${components.at(-1)!}`, fileFlags);
    return { fd, directoryFds };
  } catch {
    for (const fd of directoryFds.reverse()) { try { fs.closeSync(fd); } catch { /* best effort */ } }
    return null;
  }
}

/** Read a contained canonical path through a pinned root and descriptor-relative no-follow path. */
export function readContainedSessionFile<T>(root: string, filePath: string, read: (descriptorPath: string) => T, pinnedRoot?: PinnedSessionRoot): T | null {
  const ownerRoot = pinnedRoot ?? openPinnedSessionRoot(root);
  if (!ownerRoot || !currentPathMatchesRoot(ownerRoot)) {
    if (ownerRoot && ownerRoot !== pinnedRoot) closePinnedSessionRoot(ownerRoot);
    return null;
  }
  let opened: { fd: number; directoryFds: number[] } | null = null;
  try {
    // Observe the indexed pathname for legacy race hooks, but never read from this handle.
    // The actual payload is opened below relative to the pinned root descriptor.
    let probeFd: number | undefined;
    try {
      probeFd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    } finally {
      if (probeFd !== undefined) { try { fs.closeSync(probeFd); } catch { /* best effort */ } }
    }
    opened = openRelativeSessionFile(ownerRoot, filePath);
    if (!opened) return null;
    const initial = fs.fstatSync(opened.fd, { bigint: true });
    if (!initial.isFile() || !currentPathMatchesRoot(ownerRoot)) return null;
    const descriptorPath = process.platform === 'linux' ? `/proc/self/fd/${opened.fd}` : `/dev/fd/${opened.fd}`;
    const result = read(descriptorPath);
    const final = fs.fstatSync(opened.fd, { bigint: true });
    if (final.size !== initial.size || final.mtimeNs !== initial.mtimeNs || final.ctimeNs !== initial.ctimeNs || !currentPathMatchesRoot(ownerRoot)) return null;
    return result;
  } finally {
    if (opened) {
      try { fs.closeSync(opened.fd); } catch { /* best effort */ }
      for (const fd of opened.directoryFds.reverse()) { try { fs.closeSync(fd); } catch { /* best effort */ } }
    }
    if (ownerRoot !== pinnedRoot) closePinnedSessionRoot(ownerRoot);
  }
}

/** Resolve contained owners in priority order; readers receive a descriptor-relative alias. */
export function canonicalSessionOwners(db: ReturnType<DatabaseManager['getDb']>, sessionId: string, sessionsDir?: string, readSession: (filePath: string) => ParsedSession | null = parseSessionFile, firstOnly = false, pinnedSessionsRoot?: string, sharedPinnedRoot?: PinnedSessionRoot): Array<{ path: string; indexedPath: string; session: ParsedSession }> {
  const owners = db.prepare('SELECT path, indexed_at FROM session_files WHERE session_id = ? ORDER BY indexed_at DESC, path DESC').all(sessionId) as Array<{ path: string; indexed_at: string }>;
  // Pin the root pathname and inode. Open the configured pathname before deriving
  // its canonical string; resolving first permits a replaced real directory to win.
  let pinnedRoot: string | null = sharedPinnedRoot?.root ?? pinnedSessionsRoot ?? null;
  let pinnedDirectory: PinnedSessionRoot | null = sharedPinnedRoot ?? null;
  const ownsPinnedDirectory = sharedPinnedRoot === undefined;
  if (sessionsDir !== undefined && pinnedRoot === null) {
    pinnedDirectory = openPinnedSessionRoot(sessionsDir);
    if (!pinnedDirectory) return [];
    pinnedRoot = pinnedDirectory.root;
  }
  if (pinnedRoot !== null && pinnedDirectory === null) {
    pinnedDirectory = openPinnedSessionRoot(pinnedRoot);
    if (!pinnedDirectory) return [];
  }
  const ordered = owners.flatMap(owner => {
    let root = pinnedRoot;
    if (root === null) {
      try { root = fs.realpathSync.native(path.dirname(owner.path)); } catch { return []; }
    }
    const contained = containedUnderRoot(root, owner.path);
    return contained ? [{ path: contained, indexedPath: owner.path, root, indexedAt: owner.indexed_at }] : [];
  }).sort((a, b) => b.indexedAt.localeCompare(a.indexedAt) || b.path.localeCompare(a.path));
  const valid: Array<{ path: string; indexedPath: string; session: ParsedSession; indexedAt: string }> = [];
  try {
    for (const owner of ordered) {
      try {
        const session = readContainedSessionFile(owner.root, owner.path, readSession, pinnedDirectory ?? undefined);
        if (session?.id === sessionId) {
          valid.push({ path: owner.path, indexedPath: owner.indexedPath, session, indexedAt: owner.indexedAt });
          if (firstOnly) break;
        }
      } catch (error) {
        // A budget failure is not evidence that the transcript is invalid.
        // Surface it instead of silently turning a partial search into no hits.
        if (error instanceof SessionSearchReadLimitError) throw error;
      }
    }
    return valid
      .sort((a, b) => b.indexedAt.localeCompare(a.indexedAt) || b.path.localeCompare(a.path))
      .map(({ path: ownerPath, indexedPath, session }) => ({ path: ownerPath, indexedPath, session }));
  } finally {
    if (ownsPinnedDirectory && pinnedDirectory) closePinnedSessionRoot(pinnedDirectory);
  }
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
  /**
   * Optional retention cutoff (ms epoch). JSONL session files whose mtime is
   * strictly older than this cutoff are considered outside the retained window
   * and are skipped entirely (not queued for indexing or counted as changed).
   * This keeps incremental backfill aligned with session retention pruning:
   * sessions pruned by pruneOldSessions() are never re-indexed on a later
   * startup. Omit/0 to index every file (backwards-compatible default).
   */
  retentionCutoffMs?: number;
}

/**
 * True when a session JSONL file's last-modified time falls within the
 * retention window (mtime >= cutoff). Files older than the cutoff are treated
 * as expired and are ineligible for backfill/indexing so that pruned sessions
 * are not re-surfaced.
 */
function isWithinRetention(mtimeMs: number, retentionCutoffMs: number | undefined): boolean {
  return !retentionCutoffMs || mtimeMs >= retentionCutoffMs;
}

export function truncateMessageContent(
  content: string,
  maxLength = DEFAULT_MAX_MESSAGE_CONTENT_LENGTH,
): string {
  if (content.length <= maxLength) return content;

  const notice = `\n... (truncated, ${content.length} chars total)\n`;
  const retainedLength = Math.max(0, maxLength - notice.length);
  const prefixLength = Math.ceil(retainedLength / 2);
  const suffixLength = Math.floor(retainedLength / 2);
  const suffix = suffixLength > 0 ? content.slice(-suffixLength) : '';
  return `${content.slice(0, prefixLength)}${notice}${suffix}`;
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

/** Add only entries that are absent from an already indexed live session. */
function indexAdditiveSessionOnce(dbManager: DatabaseManager, session: ParsedSession): IndexResult {
  const db = dbManager.getDb();
  const before = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(session.id) as { count: number };
  const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id);
  const indexedIds = new Set((db.prepare('SELECT entry_id FROM messages WHERE session_id = ? AND entry_id IS NOT NULL').all(session.id) as Array<{ entry_id: string }>).map((row) => row.entry_id));
  const messages = canonicalEntries(session).filter((message) => !indexedIds.has(entryId(message)));
  if (existing && messages.length === 0) {
    return { sessionId: session.id, messagesIndexed: 0, skipped: true };
  }
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
        // Tool results can contain unbounded file or command output. Tool
        // calls are indexed separately, so retaining their output adds bloat
        // without improving session search.
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

export function parseSessionManagerSnapshot(sessionManager: SessionManagerSnapshot, ordinalOffset = 0): ParsedSession | null {
  return parseCanonicalSnapshot(sessionManager, ordinalOffset);
}

type IndexedLiveCursor = {
  entry_id: string;
  ordinal: number;
  role: string;
  kind: string;
  content: string;
  timestamp: string;
  tool_calls: string | null;
  tool_name: string | null;
  tool_call_id: string | null;
};

function getIndexedLiveCursor(dbManager: DatabaseManager, sessionId: string): IndexedLiveCursor | undefined {
  return dbManager.getDb().prepare(`
    SELECT entry_id, ordinal, role, kind, content, timestamp, tool_calls, tool_name, tool_call_id
    FROM messages
    WHERE session_id = ? AND entry_id IS NOT NULL
    ORDER BY ordinal DESC
    LIMIT 1
  `).get(sessionId) as IndexedLiveCursor | undefined;
}

function liveEntryId(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const id = (entry as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

function indexedCursorMatchesLiveEntry(header: NonNullable<ReturnType<SessionManagerSnapshot['getHeader']>>, entry: unknown, cursor: IndexedLiveCursor): boolean {
  const session = parseSessionManagerSnapshot({
    getHeader: () => header,
    getEntries: () => [entry],
  }, cursor.ordinal);
  const message = session?.messages.find((candidate) => entryId(candidate) === cursor.entry_id);
  if (!message) return false;
  return message.role === cursor.role
    && (message.kind ?? 'message') === cursor.kind
    && message.content === cursor.content
    && message.timestamp === cursor.timestamp
    && (message.toolCalls ? JSON.stringify(message.toolCalls) : null) === cursor.tool_calls
    && (message.toolName ?? null) === cursor.tool_name
    && (message.toolCallId ?? null) === cursor.tool_call_id;
}

function indexCurrentSessionOnce(dbManager: DatabaseManager, sessionManager: SessionManagerSnapshot): IndexResult | null {
  const header = sessionManager.getHeader();
  if (!header?.id) return null;
  const db = dbManager.getDb();
  const cursor = getIndexedLiveCursor(dbManager, header.id);
  const entries = sessionManager.getEntries();
  let entryOffset = 0;
  let ordinalOffset = cursor ? cursor.ordinal + 1 : 0;
  if (cursor) {
    const cursorIndex = entries.findIndex((entry) => liveEntryId(entry) === cursor.entry_id);
    if (cursorIndex >= 0) entryOffset = cursorIndex + 1;
  }
  if (entryOffset >= entries.length && db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(header.id)) {
    return { sessionId: header.id, messagesIndexed: 0, skipped: true };
  }
  const session = parseSessionManagerSnapshot({
    getHeader: () => header,
    getEntries: () => entries.slice(entryOffset),
  }, ordinalOffset);
  if (!session) return null;
  return indexAdditiveSessionOnce(dbManager, session);
}

export function indexCurrentSession(dbManager: DatabaseManager, sessionManager: SessionManagerSnapshot): IndexResult | null {
  return dbManager.withCorruptionRecovery(() => indexCurrentSessionOnce(dbManager, sessionManager));
}

function indexPersistedLiveSessionOnce(
  dbManager: DatabaseManager,
  sessionManager: SessionManagerSnapshot,
  sessionsDir?: string,
  expectedSessionId?: string,
): IndexResult | null {
  const sessionFile = sessionManager.getSessionFile?.();
  if (!sessionFile) return null;
  const contained = sessionsDir ? containedCanonicalPath(sessionsDir, sessionFile) : canonicalPath(sessionFile);
  const canonicalFile = contained ?? '';
  if (!canonicalFile || !fs.existsSync(canonicalFile)) return null;
  const session = parseSessionFile(canonicalFile);
  if (!session || (expectedSessionId && session.id !== expectedSessionId)) return null;
  return indexCanonicalSessionFileOnce(dbManager, canonicalFile, session);
}

export function indexLiveSession(dbManager: DatabaseManager, sessionManager: SessionManagerSnapshot, sessionsDir?: string): IndexResult | null {
  return dbManager.withCorruptionRecovery(() => indexLiveSessionOnce(dbManager, sessionManager, sessionsDir));
}

function indexLiveSessionOnce(dbManager: DatabaseManager, sessionManager: SessionManagerSnapshot, sessionsDir?: string): IndexResult | null {
  if (sessionManager.getSessionFile && !sessionManager.getSessionFile()) return null;
  const liveEntries = sessionManager.getEntries();
  if (liveEntries.length > 0) {
    const header = sessionManager.getHeader();
    if (header?.id) {
      const cursor = getIndexedLiveCursor(dbManager, header.id);
      if (cursor) {
        const cursorIndex = liveEntries.findIndex((entry) => liveEntryId(entry) === cursor.entry_id);
        const cursorEntry = cursorIndex >= 0 ? liveEntries[cursorIndex] : undefined;
        if (!cursorEntry || !indexedCursorMatchesLiveEntry(header, cursorEntry, cursor)) {
          return indexPersistedLiveSessionOnce(dbManager, sessionManager, sessionsDir, header.id);
        }
        if (cursorIndex + 1 < liveEntries.length && canonicalLiveFileIsFullyIndexed(dbManager, sessionManager, header.id, sessionsDir)) {
          return { sessionId: header.id, messagesIndexed: 0, skipped: true };
        }
      }
    }
    return indexCurrentSessionOnce(dbManager, {
      getHeader: () => header,
      getEntries: () => liveEntries,
    });
  }

  return indexPersistedLiveSessionOnce(dbManager, sessionManager, sessionsDir)
    ?? indexCurrentSessionOnce(dbManager, sessionManager);
}

/**
 * Remove rows created by background review subprocesses that ran with
 * `--no-session` before live indexing rejected ephemeral sessions.
 */
export function pruneEphemeralReviewSessions(dbManager: DatabaseManager): number {
  return dbManager.withCorruptionRecovery(() => {
    const db = dbManager.getDb();
    const candidates = db.prepare(`
      SELECT s.id
      FROM sessions s
      WHERE NOT EXISTS (
        SELECT 1 FROM session_files sf WHERE sf.session_id = s.id
      )
        AND (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) = 1
        AND EXISTS (
          SELECT 1
          FROM messages m
          WHERE m.session_id = s.id
            AND m.content LIKE ?
        )
    `).all('<file name="/tmp/pi-hermes-prompt-%') as Array<{ id: string }>;

    if (candidates.length === 0) return 0;

    const placeholders = candidates.map(() => '?').join(', ');
    const ids = candidates.map(({ id }) => id);
    const remove = () => {
      db.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...ids);
      return db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids).changes;
    };

    return db.transaction ? db.transaction(remove)() : remove();
  });
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

function canonicalLiveFileIsFullyIndexed(
  dbManager: DatabaseManager,
  sessionManager: SessionManagerSnapshot,
  sessionId: string,
  sessionsDir?: string,
): boolean {
  const sessionFile = sessionManager.getSessionFile?.();
  if (!sessionFile) return false;
  const contained = sessionsDir ? containedCanonicalPath(sessionsDir, sessionFile) : canonicalPath(sessionFile);
  const canonicalFile = contained ?? '';
  if (!canonicalFile || !fs.existsSync(canonicalFile)) return false;
  try {
    const owner = dbManager.getDb().prepare('SELECT session_id FROM session_files WHERE path = ?').get(canonicalFile) as { session_id: string } | undefined;
    return owner?.session_id === sessionId && storedSessionFileMatches(dbManager, getSessionFileMetadata(canonicalFile));
  } catch {
    return false;
  }
}

/** Store the supplied fingerprint under the resolved canonical file identity. */
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
  `).run(filePath, sessionId, metadata.size, metadata.mtimeMs, indexedAt.toISOString());
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
 * With retentionCutoffMs > 0, files whose mtime falls outside the window are
 * skipped (counted in expiredSkipped) so a manual reindex honors the same
 * retention policy the auto pruning enforces, instead of re-adding expired
 * sessions that pruning just deleted.
 *
 * @param dbManager — Database manager instance
 * @param sessionsDir — Path to ~/.pi/agent/sessions/
 * @param projectDir — Optional: specific project directory to index
 * @param retentionCutoffMs — Optional: epoch ms; files modified before it are skipped
 * @returns Bulk index result
 */
export function indexAllSessions(
  dbManager: DatabaseManager,
  sessionsDir: string,
  projectDir?: string,
  retentionCutoffMs = 0,
): BulkIndexResult {
  const files = getCanonicalSessionFiles(sessionsDir, projectDir);
  const result = emptyBulkIndexResult();
  let expiredSkipped = 0;

  for (const file of files) {
    if (retentionCutoffMs > 0) {
      try {
        if (!isWithinRetention(getSessionFileMetadata(file).mtimeMs, retentionCutoffMs)) {
          expiredSkipped++;
          continue;
        }
      } catch {
        // Unreadable metadata: let indexSessionFile report the real error.
      }
    }

    try {
      indexSessionFile(dbManager, file, result);
    } catch (err) {
      result.errors.push(`Error indexing ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (expiredSkipped > 0) result.expiredSkipped = expiredSkipped;
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
      if (!isWithinRetention(metadata.mtimeMs, options.retentionCutoffMs)) {
        // Outside the retained window (e.g. pruned by pruneOldSessions):
        // never re-queue it for indexing, so a pruned session does not come
        // back on the next startup backfill.
        continue;
      }
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
  const emit = (filePath: string): void => {
    if (!passedCursor) {
      if (filePath <= (cursor as string)) return;
      passedCursor = true;
    }
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
      if (!projectDir && !passedCursor && cursor && entry.isDirectory() && candidate < path.dirname(cursor)) continue;
      // Skipped prefixes must not spend a fresh yield/stat budget on every startup.
      if (!passedCursor && cursor && entry.name.endsWith('.jsonl') && candidate <= cursor) continue;
      const stat = await fs.promises.stat(candidate);
      if (stat.isDirectory() && !projectDir) {
        const children = (await fs.promises.readdir(candidate, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
          if (!checkBudget()) break;
          const childPath = path.join(candidate, child.name);
          if (!passedCursor && cursor && childPath <= cursor) continue;
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
  if (complete && cursor !== null) {
    // A suffix is not a complete ownership inventory. Wrap before cleanup or
    // clearing the cursor; this also restarts when its owner has disappeared.
    const wrapped = await discoverCanonicalSessionFiles(sessionsDir, projectDir, signal, deadline, yieldFn, onFileDiscovered, null);
    return { files: [...new Set([...files, ...wrapped.files])].sort(), complete: wrapped.complete };
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
  const startedAt = Date.now();
  const deadline = startedAt + maxDurationMs;
  const discoveryDeadline = startedAt + maxDurationMs / 3;
  const result = emptyBulkIndexResult();
  if (options.signal?.aborted) return { ...result, partial: true, aborted: true };
  const root = canonicalPath(sessionsDir);
  const scopeRoot = options.projectDir ? canonicalPath(path.resolve(root, options.projectDir)) : root;
  const relative = path.relative(root, scopeRoot);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { ...result, partial: true, errors: ['Backfill scope must remain inside the sessions root.'] };
  }
  const scopePrefix = scopeRoot.endsWith(path.sep) ? scopeRoot : `${scopeRoot}${path.sep}`;
  const cursor = getScanCursor(dbManager);
  const discovery = await discoverCanonicalSessionFiles(sessionsDir, options.projectDir, options.signal, discoveryDeadline, yieldFn, (file) => {
    if (!options.signal?.aborted) setScanCursor(dbManager, file);
  }, cursor);
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
  // Reserve half the remaining time for parsing/indexing rather than metadata alone.
  const metadataDeadline = (Date.now() + deadline) / 2;
  let metadataComplete = true;
  for (const file of orderedFiles) {
    if (options.signal?.aborted || Date.now() >= metadataDeadline) {
      metadataComplete = false;
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
    for (const file of Object.keys(deferred)) {
      if (file.startsWith(scopePrefix) && !files.includes(file)) delete deferred[file];
    }
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

  const attemptedAll = metadataComplete && changed.length <= result.sessionsProcessed + (result.deferredFiles ?? 0) && !result.reachedLimit && !result.aborted && Date.now() < deadline;
  if (discoveryComplete && attemptedAll && !options.signal?.aborted) writeMetadataValue(dbManager, SESSION_BACKFILL_SCAN_CURSOR_KEY, null);
  if (discoveryComplete && !options.signal?.aborted) {
    try { removeMissingCanonicalFiles(dbManager, files, scopeRoot); }
    catch (error) { result.errors.push(`Error cleaning missing session files: ${error instanceof Error ? error.message : String(error)}`); result.partial = true; }
  }
  if (changed.length > result.sessionsProcessed + (result.deferredFiles ?? 0) && !result.reachedLimit && !result.aborted) result.partial = true;
  if (Object.keys(deferred).some(file => file.startsWith(scopePrefix))) result.partial = true;
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
export function needsBackfill(
  dbManager: DatabaseManager,
  sessionsDir: string,
  now = new Date(),
  retentionCutoffMs = 0,
): boolean {
  const db = dbManager.getDb();
  const files = getSessionFiles(sessionsDir);
  const indexed = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };

  if (retentionCutoffMs <= 0) {
    // Retention disabled: keep the historical cheap path — a plain file-count
    // vs row-count comparison decides before any per-file stat work, so
    // large session directories stay fast on startup.
    if (files.length > indexed.count) {
      return true;
    }

    for (const file of files) {
      try {
        const metadata = getSessionFileMetadata(file);
        if (storedSessionFileMatches(dbManager, metadata)) continue;
        return true;
      } catch {
        // An unreadable or malformed session file still needs indexing.
        return true;
      }
    }

    return !isRecentBackfillTimestamp(getLastBackfillTimestamp(dbManager), now.getTime());
  }

  // Retention enabled: one metadata pass decides everything — a retained file
  // with stale stored metadata demands a backfill, and when no file is inside
  // the window there is no work at all. Returning here (instead of falling
  // through to the periodic timestamp check) keeps an all-expired store from
  // scheduling an empty backfill on every startup before a timestamp is ever
  // written.
  let hasRetainedFile = false;
  for (const file of files) {
    try {
      const metadata = getSessionFileMetadata(file);
      if (!isWithinRetention(metadata.mtimeMs, retentionCutoffMs)) continue;
      hasRetainedFile = true;
      if (!storedSessionFileMatches(dbManager, metadata)) return true;
    } catch {
      return true;
    }
  }
  if (!hasRetainedFile) {
    return false;
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

/**
 * Compute the retention cutoff (ms epoch) from a retention window in days.
 * Returns 0 (no cutoff) when retention is undefined/zero/disabled.
 */
export function retentionCutoffMs(retentionDays: number | undefined): number {
  if (!retentionDays || retentionDays <= 0) return 0;
  return Date.now() - retentionDays * 24 * 60 * 60 * 1000;
}

/**
 * Delete sessions outside the retention window, along with their messages,
 * to bound the growth of the session index database (see #183).
 *
 * A session is eligible for pruning when its session file's last-mod time is
 * older than the window (falling back to started_at when no file metadata
 * exists). This deliberately mirrors the backfill eligibility check in
 * `needsBackfill`/`indexChangedSessions` (also keyed to file mtime), so a
 * pruned session's on-disk JSONL file is never re-indexed by a later startup
 * and never re-triggers a backfill. Retention and backfill therefore agree on
 * the same eligible file set.
 *
 * `messages` and `session_files` reference `sessions`, but only `session_files`
 * is declared `ON DELETE CASCADE`. Orphaned `messages` rows are deleted
 * explicitly first so a `PRAGMA foreign_keys`-enabled delete never trips a
 * FK constraint, and so an accurate `messagesRemoved` count is reported.
 *
 * Returns the number of sessions and messages removed.
 */
export function pruneOldSessions(
  dbManager: DatabaseManager,
  retentionDays: number,
): { sessionsRemoved: number; messagesRemoved: number } {
  const db = dbManager.getDb();
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  // Match backfill's mtime policy, but keep a linked session whenever any owner
  // is still fresh. Eligibility and deletion share one transaction so a competing
  // owner update cannot turn an obsolete candidate list into destructive pruning.
  const prune = () => {
    const eligibleSessionIds = db.prepare(`
      SELECT s.id
      FROM sessions s
      LEFT JOIN session_files sf ON sf.session_id = s.id
      GROUP BY s.id
      HAVING (COUNT(sf.path) > 0 AND MAX(sf.mtime_ms) < ?)
        OR (COUNT(sf.path) = 0 AND s.started_at < ?)
    `).all(cutoffMs, cutoffIso) as Array<{ id: string }>;
    if (!eligibleSessionIds.length) return { sessionsRemoved: 0, messagesRemoved: 0 };
    const ids = eligibleSessionIds.map(row => row.id);
    const placeholders = ids.map(() => '?').join(',');
    // Messages do not cascade; delete them before their parent sessions.
    const delMessages = db.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...ids);
    const delSessions = db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids);
    return { messagesRemoved: delMessages.changes, sessionsRemoved: delSessions.changes };
  };
  return db.transaction ? db.transaction(prune)() : prune();
}
