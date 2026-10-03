import fs from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { DatabaseManager } from '../store/db.js';
import { canonicalSessionOwners, removeMissingCanonicalFile } from '../store/session-indexer.js';
import { type ParsedEntry, type ParsedSession } from '../store/session-parser.js';

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

function compactError(error: string): { content: [{ type: 'text'; text: string }]; details: { success: false; error: string } } {
  const details = { success: false as const, error };
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
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

function response(value: Record<string, any>): { content: [{ type: 'text'; text: string }]; details: Record<string, any> } {
  const details = boundedDetails(value);
  const serialized = JSON.stringify(details);
  // Never byte-truncate serialized JSON: a UTF-8-safe prefix can still be syntactically invalid.
  return { content: [{ type: 'text' as const, text: serialized }], details };
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
  const graph = (session.entries ?? []).filter(validEntry).filter((entry) => entry.kind !== 'session_info');
  const byId = new Map(graph.map((entry) => [entry.entryId as string, entry]));
  const children = new Map<string, ParsedEntry[]>();
  for (const entry of graph) {
    const parent: string | null = entry.parentId === null ? null : (entry.parentEntryId ?? null);
    if (parent && !byId.has(parent)) return null;
    if (parent) children.set(parent, [...(children.get(parent) ?? []), entry]);
  }
  const target = byId.get(targetId);
  if (!target) return null;
  const seen = new Set<string>();
  const lineage: string[] = [];
  let cursor: ParsedEntry | undefined = target;
  while (cursor) {
    const id = cursor.entryId as string;
    if (seen.has(id)) return null;
    seen.add(id);
    lineage.unshift(id);
    const parent: string | null = cursor.parentId === null ? null : (cursor.parentEntryId ?? null);
    cursor = parent ? byId.get(parent) : undefined;
  }
  const descendants = (root: string): string[] | null => {
    const result: string[] = [];
    const walk = (id: string): boolean => {
      const next = children.get(id) ?? [];
      if (next.length > 1) return false;
      if (next.length === 1) {
        const child = next[0].entryId as string;
        result.push(child);
        return walk(child);
      }
      return true;
    };
    return walk(root) ? result : null;
  };
  const active = graph.filter((entry) => !(children.get(entry.entryId as string)?.length));
  if (active.length === 0) return null;
  let branch: string[];
  if (active.length === 1) {
    branch = [];
    let leaf: ParsedEntry | undefined = active[0];
    while (leaf) {
      branch.unshift(leaf.entryId as string);
      const parent: string | null = leaf.parentId === null ? null : (leaf.parentEntryId ?? null);
      leaf = parent ? byId.get(parent) : undefined;
    }
  } else {
    const unique = descendants(targetId);
    if (!unique) return null;
    branch = [...lineage, ...unique];
  }
  if (!branch.includes(targetId)) return null;
  const messages = new Map(messageEntries(session).map((entry) => [entry.entryId as string, entry]));
  const messageBranch = branch.map((id) => messages.get(id)).filter((entry): entry is ParsedEntry => Boolean(entry));
  const targetAt = messageBranch.findIndex((entry) => entry.entryId === targetId);
  if (targetAt < 0) return null;
  return {
    before: messageBranch.slice(Math.max(0, targetAt - before), targetAt),
    after: messageBranch.slice(targetAt + 1, targetAt + 1 + after),
  };
}

function findCanonicalSession(dbManager: DatabaseManager, sessionId: string, entryId?: string, sessionsDir?: string): ParsedSession | null {
  const db = dbManager.getDb();
  const owners = canonicalSessionOwners(db, sessionId, sessionsDir);
  // Remove rows that disappeared or became invalid, but never follow an
  // unindexed `${sessionId}.jsonl` fallback or an outside-root symlink.
  const rows = db.prepare('SELECT path FROM session_files WHERE session_id = ?').all(sessionId) as Array<{ path: string }>;
  // Compare the validated indexed key, not its realpath: historical owners may be lexical aliases.
  for (const row of rows) if (!owners.some((owner) => owner.indexedPath === row.path) && !fs.existsSync(row.path)) removeMissingCanonicalFile(dbManager, row.path);
  // Owner choice is independent of entry lookup, so stale entry IDs produce a
  // precise entry_unresolvable response instead of hiding a valid transcript.
  return owners[0]?.session ?? null;
}

/** Register exact, canonical, branch-aware session evidence access. */
export function registerSessionGetTool(pi: ExtensionAPI, dbManager: DatabaseManager, options: SessionGetToolOptions = {}): void {
  pi.registerTool({
    name: 'session_get',
    label: 'Session Get',
    description: 'Open an exact canonical Pi session entry. Use the full session_id and entry_id returned by session_search; stale or ambiguous evidence fails closed.',
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
      const session = findCanonicalSession(dbManager, args.session_id, args.entry_id, options.sessionsDir);
      if (!session) return compactError('transcript_unavailable');
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
