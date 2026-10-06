import fs from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { DatabaseManager } from '../store/db.js';
import { canonicalSessionOwners, closePinnedSessionRoot, containedCanonicalPath, openPinnedSessionRoot, readContainedSessionFile, removeMissingCanonicalFile } from '../store/session-indexer.js';
import { getSessionFiles, parseSessionFileForSearch, SessionFileTooLargeError, SessionSearchReadLimitError, SESSION_SEARCH_MAX_SCAN_BYTES, type ParsedEntry, type ParsedSession } from '../store/session-parser.js';

export const SESSION_GET_MAX_CONTEXT = 10;
export const SESSION_GET_MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTLINE_ENTRIES = 500;
const MAX_ENTRY_CONTENT_BYTES = 4_000;
const MAX_DETAIL_CONTENT_BYTES = 1_200;

type SessionGetView = 'context' | 'outline' | 'metadata';
export interface SessionGetToolOptions { sessionsDir?: string }

interface PublicEntry {
  entry_id: string;
  role: string | null;
  kind: string;
  timestamp: string | null;
  tool_name: string | null;
  tool_call_id: string | null;
  tool_calls?: string[];
  content: string;
  anchor: string;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character, 'utf8') > maxBytes) break;
    result += character;
  }
  return result;
}

function entryToPublic(sessionId: string, entry: ParsedEntry, contentBytes = MAX_ENTRY_CONTENT_BYTES): PublicEntry {
  return {
    entry_id: entry.entryId as string,
    role: entry.role,
    kind: entry.kind ?? 'unknown',
    timestamp: entry.timestamp,
    tool_name: entry.toolName ?? null,
    tool_call_id: entry.toolCallId ?? null,
    ...(entry.toolCalls?.length ? { tool_calls: entry.toolCalls } : {}),
    content: truncateUtf8(entry.content, contentBytes),
    anchor: `pi://session/${sessionId}#entry=${entry.entryId}`,
  };
}

function byteSize(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }

function compactError(error: string): { content: [{ type: 'text'; text: string }]; details: { success: false; error: string }; isError: true } {
  const details = { success: false as const, error };
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details, isError: true };
}

function boundedDetails(value: Record<string, any>): Record<string, any> {
  const result = structuredClone(value);
  const compactEntries = (items: unknown) => {
    const values = Array.isArray(items) ? items : [items];
    for (const item of values) if (item && typeof item === 'object') {
      const value = item as any;
      if (typeof value.content === 'string') value.content = truncateUtf8(value.content, MAX_DETAIL_CONTENT_BYTES);
      if (typeof value.tool_name === 'string') value.tool_name = truncateUtf8(value.tool_name, 256);
      if (typeof value.tool_call_id === 'string') value.tool_call_id = truncateUtf8(value.tool_call_id, 256);
      if (Array.isArray(value.tool_calls)) {
        value.tool_calls = value.tool_calls.slice(0, 64).map((call: unknown) => typeof call === 'string' ? truncateUtf8(call, 128) : call);
      }
    }
  };
  compactEntries(result.entry);
  compactEntries(result.before);
  compactEntries(result.after);
  compactEntries(result.entries);
  const session = result.session;
  if (session && typeof session === 'object') {
    for (const key of ['project', 'cwd', 'started_at', 'ended_at', 'name', 'title']) {
      if (typeof session[key] === 'string') session[key] = truncateUtf8(session[key], key === 'cwd' ? 2_000 : 1_000);
    }
  }
  let guard = 0;
  while (byteSize(result) > SESSION_GET_MAX_OUTPUT_BYTES && guard++ < 100) {
    if (Array.isArray(result.after) && result.after.length) result.after.pop();
    else if (Array.isArray(result.before) && result.before.length) result.before.shift();
    else if (Array.isArray(result.entries) && result.entries.length) result.entries.pop();
    else {
      const session = result.session;
      if (session && typeof session.cwd === 'string' && session.cwd.length > 0) {
        // Keep a conservative reserve for JSON escaping and metadata overhead;
        // transcript content is never sourced from SQLite, so dropping this
        // diagnostic field is safer than emitting an oversized result.
        const shortened = truncateUtf8(session.cwd, 8_000);
        session.cwd = shortened === session.cwd ? '' : shortened;
        if (typeof session.project === 'string') session.project = truncateUtf8(session.project, 8_000);
      } else if (result.entry?.content) {
        result.entry.content = truncateUtf8(result.entry.content, 256);
      } else {
        if (Array.isArray(result.before)) result.before.length = 0;
        if (Array.isArray(result.after)) result.after.length = 0;
        if (Array.isArray(result.entries)) result.entries.length = 0;
      }
    }
    result.truncated = true;
  }
  if (byteSize(result) > SESSION_GET_MAX_OUTPUT_BYTES) {
    const compact = {
      success: Boolean(result.success),
      session: result.session ? { ...result.session, cwd: '', project: '' } : undefined,
      entry: result.entry ? { ...result.entry, content: '' } : undefined,
      before: [], after: [], truncated: true,
    };
    // Exact identities and their anchors must never be shortened to fit the response.
    return byteSize(compact) <= SESSION_GET_MAX_OUTPUT_BYTES
      ? compact
      : { success: false, error: 'session_get_response_limit' };
  }
  return result;
}

function response(value: Record<string, any>): { content: [{ type: 'text'; text: string }]; details: Record<string, any>; isError?: boolean } {
  const details = boundedDetails(value);
  const serialized = JSON.stringify(details);
  // Never byte-truncate serialized JSON: a UTF-8-safe prefix can still be syntactically invalid.
  return { content: [{ type: 'text' as const, text: serialized }], details, ...(details.success === false ? { isError: true } : {}) };
}

function compactDiagnostics(session: ParsedSession): { malformedLines: number; nulLines: number } {
  return {
    malformedLines: session.diagnostics?.malformedLines ?? 0,
    nulLines: session.diagnostics?.nulLines ?? 0,
  };
}

function validEntry(entry: ParsedEntry): boolean {
  return Boolean(entry.entryId) && entry.identityStatus !== 'ambiguous' && entry.identityStatus !== 'unresolvable';
}

function messageEntries(session: ParsedSession): ParsedEntry[] {
  return (session.entries ?? []).filter((entry): entry is ParsedEntry => (entry.kind === 'message' || entry.kind === 'tool_call' || entry.kind === 'tool_result') && validEntry(entry) && Boolean(entry.role) && Boolean(entry.timestamp));
}

function graphContext(session: ParsedSession, targetId: string, before: number, after: number): { before: ParsedEntry[]; after: ParsedEntry[] } | null {
  // Resolve only the requested window. A distant fork must not make an exact
  // entry unreadable when the caller requested no context around it.
  const graph = messageEntries(session);
  const graphById = new Map(graph.map((entry) => [entry.entryId as string, entry]));
  const allById = new Map((session.entries ?? []).filter(validEntry).map((entry) => [entry.entryId as string, entry]));
  const target = graphById.get(targetId);
  if (!target) return null;
  const parentCache = new Map<string, { ok: true; parent: string | null } | { ok: false }>();
  const resolveParent = (entry: ParsedEntry): { ok: true; parent: string | null } | { ok: false } => {
    const id = entry.entryId as string;
    const cached = parentCache.get(id);
    if (cached) return cached;
    let parent: string | null = entry.parentId == null ? null : (entry.parentEntryId ?? null);
    const seenParents = new Set<string>();
    while (parent && !graphById.has(parent)) {
      if (seenParents.has(parent)) { const invalid = { ok: false as const }; parentCache.set(id, invalid); return invalid; }
      seenParents.add(parent);
      const structuralParent = allById.get(parent);
      if (!structuralParent) { const invalid = { ok: false as const }; parentCache.set(id, invalid); return invalid; }
      parent = structuralParent.parentId == null ? null : (structuralParent.parentEntryId ?? null);
    }
    const resolved = { ok: true as const, parent };
    parentCache.set(id, resolved);
    return resolved;
  };
  const children = new Map<string, ParsedEntry[]>();
  for (const entry of graph) {
    const resolved = resolveParent(entry);
    if (resolved.ok && resolved.parent) children.set(resolved.parent, [...(children.get(resolved.parent) ?? []), entry]);
  }
  const beforeEntries: ParsedEntry[] = [];
  const visited = new Set([targetId]);
  let cursor = target;
  for (let distance = 0; distance < before; distance += 1) {
    const resolved = resolveParent(cursor);
    if (!resolved.ok) return null;
    if (!resolved.parent) break;
    const parent = graphById.get(resolved.parent);
    if (!parent || visited.has(resolved.parent)) return null;
    visited.add(resolved.parent);
    beforeEntries.unshift(parent);
    cursor = parent;
  }
  const afterEntries: ParsedEntry[] = [];
  cursor = target;
  for (let distance = 0; distance < after; distance += 1) {
    const next = children.get(cursor.entryId as string) ?? [];
    if (next.length > 1) return null;
    if (next.length === 0) break;
    cursor = next[0];
    const id = cursor.entryId as string;
    if (visited.has(id)) return null;
    visited.add(id);
    afterEntries.push(cursor);
  }
  return { before: beforeEntries, after: afterEntries };
}

interface CanonicalSessionLookup { session: ParsedSession | null; error?: 'transcript_ambiguous' | 'transcript_changed' | 'transcript_read_limit'; }

function discoverUnregisteredSession(sessionId: string, sessionsDir: string, read: (descriptor: string) => ParsedSession | null, budget: { remainingBytes: number }): CanonicalSessionLookup {
  const pinned = openPinnedSessionRoot(sessionsDir);
  if (!pinned) return { session: null };
  try {
    const files = [...new Set(getSessionFiles(pinned.root))];
    const preferred = path.join(pinned.root, `${sessionId}.jsonl`);
    // Identity is not a pathname: prioritize only files from the contained inventory.
    const candidates = files.includes(preferred) ? [preferred, ...files.filter(file => file !== preferred)] : files;
    const matches: ParsedSession[] = [];
    for (const file of candidates) {
      let requestedHeaderRead = false;
      const header = readContainedSessionFile(pinned.root, file, descriptor => {
        const candidate = parseSessionFileForSearch(descriptor, { sessionId, headerOnly: true, budget });
        requestedHeaderRead = candidate?.id === sessionId;
        return candidate;
      }, pinned);
      if (!header && requestedHeaderRead) return { session: null, error: 'transcript_changed' };
      if (header?.id !== sessionId) continue;
      // Identity is established by Pi's leading header, not the candidate name.
      // A second contained source is ambiguous even before loading its payload.
      if (matches.length) return { session: null, error: 'transcript_ambiguous' };
      const parsed = readContainedSessionFile(pinned.root, file, read, pinned);
      // The accepted target header disappeared or changed during bounded parsing.
      if (!parsed) return { session: null, error: 'transcript_changed' };
      if (parsed?.id !== sessionId) continue;
      matches.push(parsed);
      if (matches.length > 1) return { session: null, error: 'transcript_ambiguous' };
    }
    return { session: matches[0] ?? null };
  } finally { closePinnedSessionRoot(pinned); }
}

function findCanonicalSession(dbManager: DatabaseManager, sessionId: string, sessionsDir: string | undefined, read: (descriptor: string) => ParsedSession | null, budget: { remainingBytes: number }): CanonicalSessionLookup {
  const db = dbManager.getDb();
  const owners = canonicalSessionOwners(db, sessionId, sessionsDir, read);
  // Remove rows that disappeared or became invalid, but never follow an
  // unindexed `${sessionId}.jsonl` fallback or an outside-root symlink.
  const rows = db.prepare('SELECT path FROM session_files WHERE session_id = ?').all(sessionId) as Array<{ path: string }>;
  // Compare the validated indexed key, not its realpath: historical owners may be lexical aliases.
  for (const row of rows) if (!owners.some((owner) => owner.indexedPath === row.path) && !fs.existsSync(row.path)) removeMissingCanonicalFile(dbManager, row.path);
  if (owners[0]?.session) return { session: owners[0].session };
  const containedExisting = sessionsDir && rows.some(row => fs.existsSync(row.path) && containedCanonicalPath(sessionsDir, row.path) !== null);
  if (containedExisting) return { session: null, error: 'transcript_changed' };
  if (sessionsDir) {
    try {
      const discovered = discoverUnregisteredSession(sessionId, sessionsDir, read, budget);
      if (discovered.session || discovered.error) return discovered;
    } catch (error) {
      if (error instanceof SessionSearchReadLimitError || error instanceof SessionFileTooLargeError) return { session: null, error: 'transcript_read_limit' };
      throw error;
    }
  }
  return { session: null };
}

/** Retain only a bounded graph and the requested display payload, not the full JSONL. */
function readSessionForGet(descriptor: string, sessionId: string, entryId: string | undefined, view: SessionGetView, before: number, after: number, budget: { remainingBytes: number }, retainedBudget: { remainingBytes: number }): ParsedSession | null {
  const projectPayload = (entry: ParsedEntry): ParsedEntry => ({ ...entry, content: truncateUtf8(entry.content, view === 'outline' || !entryId ? 320 : MAX_ENTRY_CONTENT_BYTES) });
  if (view === 'metadata' || (view === 'context' && entryId && !before && !after)) {
    return parseSessionFileForSearch(descriptor, { sessionId, entryIds: new Set(entryId && view !== 'metadata' ? [entryId] : []), budget, retainedBudget, transformEntry: projectPayload });
  }
  const session = parseSessionFileForSearch(descriptor, {
    sessionId, retainAllEntries: true, budget, retainedBudget,
    transformEntry: entry => ({ id: entry.id, entryId: entry.entryId, identityStatus: entry.identityStatus, kind: entry.kind, parentId: entry.parentId, parentEntryId: entry.parentEntryId, ordinal: entry.ordinal, role: entry.role, timestamp: entry.timestamp, diagnostics: entry.diagnostics, content: '' }),
  });
  if (!session || session.id !== sessionId) return null;
  let wanted: ParsedEntry[];
  if (view === 'outline' || !entryId) wanted = messageEntries(session).slice(0, MAX_OUTLINE_ENTRIES);
  else {
    const target = messageEntries(session).find(entry => entry.entryId === entryId);
    const context = target && graphContext(session, entryId, before, after);
    if (!target || !context) return session;
    wanted = [...context.before, target, ...context.after];
  }
  if (!wanted.length) return session;
  const payload = parseSessionFileForSearch(descriptor, { sessionId, entryIds: new Set(wanted.map(entry => entry.entryId!)), budget, retainedBudget, transformEntry: projectPayload });
  if (!payload || payload.id !== sessionId) return null;
  const byId = new Map(payload.entries?.map(entry => [entry.entryId, entry]));
  session.entries = session.entries?.map(entry => byId.get(entry.entryId) ?? entry);
  return session;
}

/** Register exact, canonical, branch-aware session evidence access. */
export function registerSessionGetTool(pi: ExtensionAPI, dbManager: DatabaseManager, options: SessionGetToolOptions = {}): void {
  pi.registerTool({
    name: 'session_get',
    label: 'Session Get',
    description: 'Open an exact canonical Pi session entry. Use the separate full session_id and entry_id fields returned by session_search; never pass a pi:// anchor URI as entry_id. Metadata and outline are not proof of a requested entry, and every failure has success:false.',
    promptSnippet: 'Open one exact session entry after session_search',
    promptGuidelines: [
      'Copy session_id and entry_id as separate fields from session_search; do not convert the pi:// anchor URI into entry_id.',
      'Use before and after only for the requested local context window; a distant fork outside that window must not block an exact entry.',
      'Treat success:false and its error as a real failure. Metadata or outline alone do not confirm that a requested entry is available.',
    ],
    parameters: Type.Object({
      session_id: Type.String({ description: 'Full canonical session ID.' }),
      entry_id: Type.Optional(Type.String({ description: 'Full canonical logical entry ID.' })),
      before: Type.Optional(Type.Number({ minimum: 0, maximum: SESSION_GET_MAX_CONTEXT })),
      after: Type.Optional(Type.Number({ minimum: 0, maximum: SESSION_GET_MAX_CONTEXT })),
      view: Type.Optional(Type.Union([Type.Literal('context'), Type.Literal('outline'), Type.Literal('metadata')])),
    }),
    execute: async (_toolCallId: string, args: { session_id: string; entry_id?: string; before?: number; after?: number; view?: SessionGetView }) => {
      if (!args.session_id?.trim()) return compactError('invalid_session_id');
      if (args.entry_id !== undefined && !args.entry_id.trim()) return compactError('invalid_entry_id');
      try {
        dbManager.assertSessionEvidenceAvailable();
      } catch (error) {
        if (error instanceof Error && (error.name === 'SessionEvidenceUnavailableError' || (error as Error & { code?: string }).code === 'SESSION_EVIDENCE_UNAVAILABLE' || /migration pending|evidence unavailable/i.test(error.message))) return compactError('session_evidence_unavailable');
        return compactError('transcript_unavailable');
      }
      const before = Math.min(Math.max(Number.isFinite(args.before) ? Math.floor(args.before as number) : 0, 0), SESSION_GET_MAX_CONTEXT);
      const after = Math.min(Math.max(Number.isFinite(args.after) ? Math.floor(args.after as number) : 0, 0), SESSION_GET_MAX_CONTEXT);
      let lookup: CanonicalSessionLookup;
      const budget = { remainingBytes: SESSION_SEARCH_MAX_SCAN_BYTES };
      const retainedBudget = { remainingBytes: 8 * 1024 * 1024 };
      const read = (descriptor: string) => readSessionForGet(descriptor, args.session_id, args.entry_id, args.view ?? 'context', before, after, budget, retainedBudget);
      try { lookup = findCanonicalSession(dbManager, args.session_id, options.sessionsDir, read, budget); }
      catch (error) {
        if (error instanceof SessionSearchReadLimitError) return compactError('transcript_read_limit');
        return compactError('transcript_unavailable');
      }
      if (!lookup.session) return compactError(lookup.error ?? 'transcript_unavailable');
      const session = lookup.session;
      const metadata = {
        session_id: session.id, project: session.project, cwd: session.cwd,
        started_at: session.startedAt, ended_at: session.endedAt, name: session.name ?? null, title: session.title ?? null,
      };
      const diagnostics = compactDiagnostics(session);
      if ((args.view ?? 'context') === 'metadata') return response({ success: true, session: metadata, diagnostics });
      const entries = messageEntries(session);
      if (!args.entry_id || args.view === 'outline') {
        const outlined = entries.slice(0, MAX_OUTLINE_ENTRIES).map((entry) => entryToPublic(session.id, entry, 320));
        return response({ success: true, session: metadata, diagnostics, entries: outlined, outline_truncated: entries.length > outlined.length });
      }
      const entry = entries.find((candidate) => candidate.entryId === args.entry_id);
      if (!entry) return compactError('entry_unresolvable');
      const context = graphContext(session, args.entry_id, before, after);
      if (!context) return compactError('branch_unresolvable');
      return response({
        success: true, session: metadata, diagnostics, entry: entryToPublic(session.id, entry),
        before: context.before.map((item) => entryToPublic(session.id, item)),
        after: context.after.map((item) => entryToPublic(session.id, item)),
      });
    },
  });
}
