import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { SessionEntryKind, SessionEntryIdentityStatus, SessionGraphDiagnostics } from '../types.js';

export interface ParsedSession {
  id: string;
  project: string;
  cwd: string;
  startedAt: string;
  endedAt: string | null;
  name?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
  messages: ParsedMessage[];
  entries?: ParsedEntry[];
  diagnostics?: SessionGraphDiagnostics;
}

export interface ParsedEntry {
  id: string | null;
  entryId?: string | null;
  identityStatus?: SessionEntryIdentityStatus;
  kind?: SessionEntryKind;
  parentId?: string | null;
  parentEntryId?: string | null;
  ordinal?: number;
  role: 'user' | 'assistant' | 'system' | null;
  content: string;
  timestamp: string | null;
  toolName?: string | null;
  toolCallId?: string | null;
  toolCalls?: string[];
  diagnostics?: string[];
}

export interface ParsedMessage extends ParsedEntry {
  kind?: 'message' | 'tool_call' | 'tool_result';
  id: string;
  entryId?: string;
  role: 'user' | 'assistant' | 'system';
  timestamp: string;
}

interface JsonlEntry {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  name?: unknown;
  title?: unknown;
  message?: { role?: unknown; content?: unknown; timestamp?: unknown; toolName?: unknown; toolCallId?: unknown };
  [key: string]: unknown;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}

/** Derive the only permitted public synthetic identity from stable entry facts. */
export function deriveSyntheticEntryId(input: {
  sessionId: string;
  kind: string;
  parentIdentity: string | null;
  timestamp: string | null;
  role: string | null;
  toolIdentity: string | null;
  payload: unknown;
}): string | null {
  if (!input.sessionId || !input.kind || !input.parentIdentity || !input.timestamp || !input.payload) return null;
  if (!input.role && !input.toolIdentity) return null;
  const tuple = canonicalize({
    version: 1,
    session_id: input.sessionId,
    kind: input.kind,
    parent: input.parentIdentity,
    timestamp: input.timestamp,
    role: input.role,
    tool: input.toolIdentity,
    payload: input.payload,
  });
  return `syn:v1:${digest(tuple)}`;
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    if (b.type === 'tool_result') {
      if (typeof b.content === 'string') parts.push(b.content);
      else if (Array.isArray(b.content)) {
        for (const item of b.content) {
          if (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'text') {
            const text = (item as Record<string, unknown>).text;
            if (typeof text === 'string') parts.push(text);
          }
        }
      }
    }
  }
  return parts.join('\n').trim();
}

function toolBlocks(content: unknown): Array<{ name: string; id: string | null }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!block || typeof block !== 'object') return [];
    const b = block as Record<string, unknown>;
    if ((b.type !== 'tool_use' && b.type !== 'toolCall') || typeof b.name !== 'string') return [];
    const id = typeof b.id === 'string' ? b.id : typeof b.toolCallId === 'string' ? b.toolCallId : null;
    return [{ name: b.name, id }];
  });
}

function extractToolCalls(content: unknown): string[] | undefined {
  const calls = toolBlocks(content).map((call) => call.name);
  return calls.length ? calls : undefined;
}

function extractToolCallId(message: JsonlEntry['message'], content: unknown): string | null {
  if (typeof message?.toolCallId === 'string' && message.toolCallId) return message.toolCallId;
  const callId = toolBlocks(content)[0]?.id;
  if (callId) return callId;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const value = block as Record<string, unknown>;
      if (value.type === 'tool_result') {
        if (typeof value.toolCallId === 'string' && value.toolCallId) return value.toolCallId;
        if (typeof value.id === 'string' && value.id) return value.id;
      }
    }
  }
  return null;
}

function toolIdentity(content: unknown): string | null {
  return extractToolCalls(content)?.join('\u001f') ?? null;
}

function entryKind(entry: JsonlEntry): SessionEntryKind {
  if (entry.type === 'message') return 'message';
  if (entry.type === 'session_info' || entry.type === 'session') return 'session_info';
  if (typeof entry.type === 'string') return 'structural';
  return 'unknown';
}

function graphDiagnostics(entries: ParsedEntry[], malformedLines: number, nulLines: number): SessionGraphDiagnostics {
  const byId = new Map<string, ParsedEntry>();
  const duplicateStructuralIds: string[] = [];
  for (const entry of entries) {
    if (!entry.entryId) continue;
    if (byId.has(entry.entryId)) duplicateStructuralIds.push(entry.entryId);
    else byId.set(entry.entryId, entry);
  }
  const orphanParents = entries.filter((entry) => entry.parentEntryId && !byId.has(entry.parentEntryId)).map((entry) => entry.entryId ?? `ordinal:${entry.ordinal}`);
  const cycles: string[][] = [];
  for (const entry of entries) {
    const seen = new Set<string>();
    const chain: string[] = [];
    let current: ParsedEntry | undefined = entry;
    while (current?.parentEntryId) {
      if (seen.has(current.parentEntryId)) {
        cycles.push([...chain, current.parentEntryId]);
        break;
      }
      seen.add(current.parentEntryId);
      chain.push(current.parentEntryId);
      current = byId.get(current.parentEntryId);
    }
  }
  const children = new Map<string, number>();
  for (const entry of entries) if (entry.parentEntryId) children.set(entry.parentEntryId, (children.get(entry.parentEntryId) ?? 0) + 1);
  const multipleDescendantLeaves = [...children].filter(([, count]) => count > 1).map(([id]) => id);
  return { malformedLines, nulLines, duplicateStructuralIds, cycles, orphanParents, multipleDescendantLeaves, messages: [] };
}

/** Return the active canonical branch, or null when graph invariants cannot resolve it safely. */
export function resolveActiveLineage(entries: readonly ParsedEntry[]): string[] | null {
  const valid = entries.filter((entry) => entry.kind !== 'session_info' && entry.entryId && entry.identityStatus !== 'ambiguous' && entry.identityStatus !== 'unresolvable');
  const byId = new Map(valid.map((entry) => [entry.entryId as string, entry]));
  const children = new Map<string, ParsedEntry[]>();
  for (const entry of valid) {
    if (entry.parentEntryId && !byId.has(entry.parentEntryId)) return null;
    if (entry.parentEntryId) children.set(entry.parentEntryId, [...(children.get(entry.parentEntryId) ?? []), entry]);
  }
  const leaves = valid.filter((entry) => !(children.get(entry.entryId as string)?.length));
  if (!leaves.length || leaves.length > 1) return null;
  const leaf = [...leaves].sort((a, b) => (b.ordinal ?? 0) - (a.ordinal ?? 0))[0];
  if (leaves.some((candidate) => (candidate.ordinal ?? 0) > (leaf.ordinal ?? 0))) return null;
  const lineage: string[] = [];
  const seen = new Set<string>();
  let current: ParsedEntry | undefined = leaf;
  while (current) {
    if (seen.has(current.entryId as string)) return null;
    seen.add(current.entryId as string);
    lineage.unshift(current.entryId as string);
    current = current.parentEntryId ? byId.get(current.parentEntryId) : undefined;
  }
  return lineage;
}

function parseEntry(raw: JsonlEntry, sessionId: string, ordinal: number, identityByRawId: Map<string, string | null>): ParsedEntry {
  const kind = entryKind(raw);
  const rawRole = raw.message?.role;
  const role = rawRole === 'toolResult' ? 'system' : rawRole === 'user' || rawRole === 'assistant' || rawRole === 'system' ? rawRole : null;
  const blocks = toolBlocks(raw.message?.content);
  const content = extractTextContent(raw.message?.content) || (blocks.length ? `Tool call: ${blocks.map((call) => call.name).join(', ')}` : '');
  const timestamp = typeof raw.timestamp === 'string' ? raw.timestamp : typeof raw.message?.timestamp === 'number' ? new Date(raw.message.timestamp).toISOString() : null;
  const rawParentId = typeof raw.parentId === 'string' ? raw.parentId : null;
  const parentEntryId = rawParentId ? identityByRawId.get(rawParentId) ?? rawParentId : 'root';
  const nativeId = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : null;
  const toolName = typeof raw.message?.toolName === 'string' ? raw.message.toolName : blocks[0]?.name ?? null;
  const payload = { type: raw.type, message: raw.message, name: raw.name, title: raw.title };
  const synthetic = nativeId ? null : deriveSyntheticEntryId({ sessionId, kind, parentIdentity: parentEntryId, timestamp, role, toolIdentity: toolName, payload });
  const entryId = nativeId ?? synthetic;
  if (nativeId) identityByRawId.set(nativeId, nativeId);
  else if (synthetic) identityByRawId.set(`ordinal:${ordinal}`, synthetic);
  return {
    id: nativeId, entryId, identityStatus: nativeId ? 'native' : synthetic ? 'synthetic' : 'unresolvable',
    kind: rawRole === 'toolResult' ? 'tool_result' : blocks.length ? 'tool_call' : kind,
    parentId: rawParentId, parentEntryId, ordinal, role, content, timestamp, toolName,
    toolCallId: extractToolCallId(raw.message, raw.message?.content),
    toolCalls: blocks.length ? extractToolCalls(raw.message?.content) : undefined,
    diagnostics: entryId ? [] : ['missing-or-non-reproducible-identity'],
  };
}

function parseEntries(rawEntries: JsonlEntry[], sessionId: string, malformedLines: number, nulLines: number): { entries: ParsedEntry[]; diagnostics: SessionGraphDiagnostics } {
  const identityByRawId = new Map<string, string | null>();
  const entries = rawEntries.map((raw, ordinal) => parseEntry(raw, sessionId, ordinal, identityByRawId));
  const counts = new Map<string, number>();
  for (const entry of entries) if (entry.entryId) counts.set(entry.entryId, (counts.get(entry.entryId) ?? 0) + 1);
  for (const entry of entries) {
    if (entry.entryId && (counts.get(entry.entryId) ?? 0) > 1) {
      entry.identityStatus = 'ambiguous';
      entry.diagnostics = [...(entry.diagnostics ?? []), 'duplicate-entry-id'];
    }
  }
  const diagnostics = graphDiagnostics(entries, malformedLines, nulLines);
  return { entries, diagnostics };
}

function parseRawSession(content: string): ParsedSession | null {
  const rawEntries: JsonlEntry[] = [];
  let malformedLines = 0;
  let nulLines = 0;
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let startedAt: string | null = null;
  let name: string | null = null;
  let title: string | null = null;
  let metadata: Record<string, unknown> | null = null;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    if (line.includes('\0')) { nulLines++; continue; }
    try {
      const entry = JSON.parse(line) as JsonlEntry;
      if (!entry || typeof entry !== 'object') { malformedLines++; continue; }
      if (entry.type === 'session' && typeof entry.id === 'string') {
        sessionId = entry.id;
        cwd = typeof entry.cwd === 'string' ? entry.cwd : cwd;
        startedAt = typeof entry.timestamp === 'string' ? entry.timestamp : startedAt;
      }
      if (entry.type === 'session_info' || entry.type === 'session') {
        if (entry.type === 'session_info') metadata = { ...entry };
        if (typeof entry.name === 'string' && entry.name.trim()) name = entry.name;
        else if (entry.name === '') name = null;
        if (typeof entry.title === 'string' && entry.title.trim()) title = entry.title;
        else if (entry.title === '') title = null;
      }
      rawEntries.push(entry);
    } catch { malformedLines++; }
  }
  if (!sessionId || !cwd || !startedAt) return null;
  const parsed = parseEntries(rawEntries, sessionId, malformedLines, nulLines);
  const messages = parsed.entries.filter((entry): entry is ParsedMessage => (entry.kind === 'message' || entry.kind === 'tool_call' || entry.kind === 'tool_result') && !!entry.content && !!entry.entryId && entry.identityStatus !== 'ambiguous' && entry.identityStatus !== 'unresolvable' && !!entry.role && !!entry.timestamp).map((entry) => ({ ...entry, id: entry.entryId as string, entryId: entry.entryId as string, role: entry.role as ParsedMessage['role'], timestamp: entry.timestamp as string, kind: entry.kind as ParsedMessage['kind'] }));
  return { id: sessionId, project: path.basename(cwd) || cwd, cwd, startedAt, endedAt: null, name, title, metadata, messages, entries: parsed.entries, diagnostics: parsed.diagnostics };
}

export class SessionFileTooLargeError extends Error {
  constructor(public readonly filePath: string, public readonly maxBytes: number) {
    super(`Session file exceeds bounded read limit: ${filePath}`);
    this.name = 'SessionFileTooLargeError';
  }
}

/**
 * Parse a JSONL session file, optionally using a hard bounded read.
 *
 * The bounded path reads at most maxBytes + 1 bytes and checks the file size
 * again through the open descriptor, so a file that grows after discovery
 * cannot fall through to an unbounded synchronous read.
 */
export function parseSessionFile(filePath: string, maxBytes?: number): ParsedSession | null {
  if (maxBytes === undefined) return parseRawSession(fs.readFileSync(filePath, 'utf8'));
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a non-negative safe integer');

  const initial = fs.statSync(filePath);
  if (initial.size > maxBytes) throw new SessionFileTooLargeError(filePath, maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      chunks.push(chunk.subarray(0, read));
      total += read;
    }
    const final = fs.fstatSync(fd);
    if (total > maxBytes || final.size > maxBytes) throw new SessionFileTooLargeError(filePath, maxBytes);
    return parseRawSession(Buffer.concat(chunks, total).toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

export const SESSION_SEARCH_MAX_SCAN_BYTES = 512 * 1024 * 1024;
export const SESSION_SEARCH_MAX_LINE_BYTES = 8 * 1024 * 1024;
const SESSION_SEARCH_MAX_ENTRIES = 100_000;

export class SessionSearchReadLimitError extends Error {
  constructor() {
    super('Session search read limit reached; narrow the project, session, or date filters.');
    this.name = 'SessionSearchReadLimitError';
  }
}

export interface SessionSearchReadOptions {
  sessionId: string;
  entryIds?: ReadonlySet<string>;
  /** Shared by all canonical reads in one search, including fallback queries. */
  budget: { remainingBytes: number };
  /** Reduce a matched entry before retaining it; classification uses its full payload. */
  transformEntry?: (entry: ParsedEntry) => ParsedEntry;
}

/** Read canonical metadata and requested entries without retaining the whole transcript. */
export function parseSessionFileForSearch(filePath: string, options: SessionSearchReadOptions): ParsedSession | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    const initial = fs.fstatSync(fd);
    if (initial.size > options.budget.remainingBytes) throw new SessionSearchReadLimitError();
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let fragments: Buffer[] = [];
    let lineBytes = 0;
    let ordinal = 0;
    let malformedLines = 0;
    let nulLines = 0;
    let id: string | null = null;
    let cwd: string | null = null;
    let startedAt: string | null = null;
    let name: string | null = null;
    let title: string | null = null;
    const identityByRawId = new Map<string, string | null>();
    const entries = new Map<string, ParsedEntry>();
    const wantsSynthetic = [...(options.entryIds ?? [])].some(value => value.startsWith('syn:v1:'));
    const consume = (line: string): void => {
      if (!line.trim()) return;
      if (line.includes('\0')) { nulLines++; return; }
      let raw: JsonlEntry;
      try { raw = JSON.parse(line) as JsonlEntry; } catch { malformedLines++; return; }
      if (!raw || typeof raw !== 'object') { malformedLines++; return; }
      if (++ordinal > SESSION_SEARCH_MAX_ENTRIES) throw new SessionSearchReadLimitError();
      if (raw.type === 'session' && typeof raw.id === 'string') {
        id = raw.id;
        cwd = typeof raw.cwd === 'string' ? raw.cwd : cwd;
        startedAt = typeof raw.timestamp === 'string' ? raw.timestamp : startedAt;
      }
      if (raw.type === 'session_info' || raw.type === 'session') {
        if (typeof raw.name === 'string' && raw.name.trim()) name = raw.name;
        else if (raw.name === '') name = null;
        if (typeof raw.title === 'string' && raw.title.trim()) title = raw.title;
        else if (raw.title === '') title = null;
      }
      const nativeId = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : null;
      // Native parent identities are unchanged. Only synthetic identities need
      // the ordinal map when the requested evidence contains a synthetic ID.
      if (!options.entryIds?.has(nativeId ?? '') && !(wantsSynthetic && !nativeId)) return;
      const entry = parseEntry(raw, options.sessionId, ordinal - 1, identityByRawId);
      if (!entry.entryId || !options.entryIds?.has(entry.entryId)) return;
      if (entries.has(entry.entryId)) {
        entries.get(entry.entryId)!.identityStatus = 'ambiguous';
        return;
      }
      const retained = options.transformEntry?.(entry) ?? { ...entry, content: entry.content.slice(0, 4_000) };
      entries.set(entry.entryId, { ...retained, content: retained.content.slice(0, 8_000) });
    };
    const addFragment = (part: Buffer): void => {
      lineBytes += part.length;
      if (lineBytes > SESSION_SEARCH_MAX_LINE_BYTES) throw new SessionSearchReadLimitError();
      if (part.length) fragments.push(Buffer.from(part));
    };
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!read) break;
      options.budget.remainingBytes -= read;
      if (options.budget.remainingBytes < 0) throw new SessionSearchReadLimitError();
      let start = 0;
      for (let end = 0; end < read; end++) {
        if (chunk[end] !== 10) continue;
        addFragment(chunk.subarray(start, end));
        consume(Buffer.concat(fragments, lineBytes).toString('utf8'));
        fragments = [];
        lineBytes = 0;
        start = end + 1;
      }
      addFragment(chunk.subarray(start, read));
    }
    if (lineBytes) consume(Buffer.concat(fragments, lineBytes).toString('utf8'));
    const final = fs.fstatSync(fd);
    if (final.size !== initial.size || final.mtimeMs !== initial.mtimeMs) return null;
    if (id !== options.sessionId || !cwd || !startedAt) return null;
    return {
      id, project: path.basename(cwd) || cwd, cwd, startedAt, endedAt: null, name, title, metadata: null,
      entries: [...entries.values()], messages: [],
      diagnostics: { malformedLines, nulLines, duplicateStructuralIds: [], cycles: [], orphanParents: [], multipleDescendantLeaves: [], messages: [] },
    };
  } finally { fs.closeSync(fd); }
}

export function parseSessionEntries(content: string, sessionId: string): ParsedEntry[] {
  const parsed = parseRawSession(content.replace(/^.*$/m, (line) => line));
  if (parsed?.id === sessionId) return parsed.entries ?? [];
  const lines = content.split('\n').filter((line) => line.trim());
  const raw = lines.flatMap((line) => { try { return [JSON.parse(line) as JsonlEntry]; } catch { return []; } });
  return parseEntries(raw, sessionId, 0, 0).entries;
}

/** Parse the live Pi snapshot through the same identity/graph path as disk JSONL. */
export function parseSessionManagerSnapshot(sessionManager: {
  getHeader: () => { id: string; timestamp: string; cwd: string } | null;
  getEntries: () => unknown[];
}): ParsedSession | null {
  const header = sessionManager.getHeader();
  if (!header?.id || !header.cwd || !header.timestamp) return null;
  const rawEntries = sessionManager.getEntries().filter((entry): entry is JsonlEntry => !!entry && typeof entry === 'object').map((entry) => entry as JsonlEntry);
  const parsed = parseEntries(rawEntries, header.id, 0, 0);
  const messages = parsed.entries.filter((entry): entry is ParsedMessage => (entry.kind === 'message' || entry.kind === 'tool_call' || entry.kind === 'tool_result') && !!entry.content && !!entry.entryId && entry.identityStatus !== 'ambiguous' && entry.identityStatus !== 'unresolvable' && !!entry.role && !!entry.timestamp).map((entry) => ({ ...entry, id: entry.entryId as string, entryId: entry.entryId as string, role: entry.role as ParsedMessage['role'], timestamp: entry.timestamp as string, kind: entry.kind as ParsedMessage['kind'] }));
  return { id: header.id, project: path.basename(header.cwd) || header.cwd, cwd: header.cwd, startedAt: header.timestamp, endedAt: null, name: null, title: null, metadata: null, messages, entries: parsed.entries, diagnostics: parsed.diagnostics };
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** List only JSONL files whose real paths remain below the configured sessions root. */
export function getSessionFiles(sessionsDir: string, projectDir?: string): string[] {
  if (!fs.existsSync(sessionsDir)) return [];
  const root = fs.realpathSync.native(sessionsDir);
  const dir = projectDir ? path.resolve(root, projectDir) : root;
  if (!isWithinRoot(root, dir) || !fs.existsSync(dir)) return [];
  const files: string[] = [];
  const addFile = (filePath: string): void => {
    if (!filePath.endsWith('.jsonl')) return;
    try {
      const real = fs.realpathSync.native(filePath);
      if (isWithinRoot(root, real) && fs.statSync(real).isFile()) files.push(real);
    } catch { /* disappearing or unreadable files are not canonical evidence */ }
  };
  if (projectDir) {
    for (const entry of fs.readdirSync(dir)) addFile(path.join(dir, entry));
    return files;
  }
  for (const entry of fs.readdirSync(root)) {
    const entryPath = path.join(root, entry);
    let stat: fs.Stats;
    try { stat = fs.statSync(entryPath); } catch { continue; }
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entryPath)) addFile(path.join(entryPath, child));
    } else if (stat.isFile()) addFile(entryPath);
  }
  return files;
}

export function decodeProjectDir(dirName: string): string {
  const cleaned = dirName.replace(/^-+|-+$/g, '');
  const segments = cleaned.split('-');
  return segments[segments.length - 1] ?? cleaned;
}
