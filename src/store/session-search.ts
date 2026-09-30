import { DatabaseManager } from './db.js';
import { parseSessionFileForSearch, SessionSearchReadLimitError, SESSION_SEARCH_MAX_SCAN_BYTES, type ParsedEntry, type ParsedSession } from './session-parser.js';
import { canonicalSessionOwners } from './session-indexer.js';
import {
  buildFallbackFts5Query,
  buildNaturalLanguageFallbackQuery,
  hasExplicitFts5Operator,
  isFts5QueryError,
  normalizeFts5Query,
  normalizeNaturalLanguageFts5Query,
} from './fts-query.js';

/** Legacy search result kept compatible with the original tool. */
export interface SessionSearchResult {
  sessionId: string;
  project: string;
  role: string;
  content: string;
  timestamp: string;
  snippet: string;
  /** Original SQLite character count, before the bounded payload projection. */
  contentChars?: number;
}

export interface SessionSearchOptions {
  limit?: number;
  project?: string;
  role?: string;
  since?: string;
  /** Configured JSONL root used to reject stale/outside owners. */
  sessionsDir?: string;
}

export interface SessionSearchEvidence {
  sessionId: string;
  entryId: string;
  project: string;
  cwd: string;
  name: string | null;
  role: string;
  kind: string;
  tool: string | null;
  tool_call_id: string | null;
  timestamp: string;
  snippet: string;
  score: number;
  scoreMode: 'bm25' | 'like';
  anchor: string;
}

export interface SessionSearchEvidenceOptions extends SessionSearchOptions {
  /** Exact ID or a prefix. A prefix must resolve to one session. */
  sessionId?: string;
  /** Include the exact current session ID; canonical JSONL openability is still mandatory. */
  includeCurrentSession?: boolean;
  /** Exact current session ID; required when includeCurrentSession is true. */
  currentSessionId?: string;
  /** Include structural/service entries. */
  includeService?: boolean;
  /** Include tool-call and tool-result entries. */
  includeToolOutput?: boolean;
  /** Maximum code points in each returned snippet. */
  snippetChars?: number;
}

export interface SessionSearchEvidenceOutcome {
  results: SessionSearchEvidence[];
  ambiguousSessionIds: string[];
}

type SearchMatch =
  | { type: 'fts'; query: string }
  | { type: 'like'; terms: string[] };

const QUERY_TOKEN_PATTERN = /"([^"]*)"|(\S+)/g;
const NATURAL_LANGUAGE_CONNECTORS = new Set(['and', 'or', 'not', 'near']);
const DEFAULT_EVIDENCE_LIMIT = 10;
const MAX_EVIDENCE_LIMIT = 50;
const DEFAULT_SNIPPET_CHARS = 1_200;
const MAX_SNIPPET_CHARS = 4_000;
const MAX_EVIDENCE_BYTES = 50 * 1024;
const MAX_HITS_PER_SESSION = 3;
// Native/synthetic keys stay exact; oversized identities fail rather than become broken anchors.
const MAX_SEARCH_ID_CHARS = 65_536;
const MAX_CANDIDATE_KEY_BYTES = 8 * 1024 * 1024;
const COMPACT_CANDIDATE_FIELDS = `m.rowid AS candidate_rowid, length(m.session_id) AS session_chars,
  coalesce(length(m.entry_id), 0) AS entry_chars`;

function escapeLikePattern(text: string): string { return text.replace(/[\\%_]/g, '\\$&'); }
function collectLikeTerms(query: string): string[] {
  const terms: string[] = [];
  for (const match of query.matchAll(QUERY_TOKEN_PATTERN)) {
    const phrase = match[1];
    const term = match[2];
    if (phrase === undefined && term && NATURAL_LANGUAGE_CONNECTORS.has(term.toLowerCase())) continue;
    const rawValue = phrase ?? term ?? '';
    if (rawValue.length > 0) terms.push(rawValue);
  }
  return terms;
}

function mapRows(rows: Array<{ session_id: string; project: string; role: string; content: string; timestamp: string; content_chars: number }>): SessionSearchResult[] {
  return rows.map(row => ({ sessionId: row.session_id, project: row.project, role: row.role, content: row.content, timestamp: row.timestamp, snippet: row.content, contentChars: row.content_chars }));
}

/** Budget compact key sizes before materializing exact keys through any SQLite adapter. */
function readSearchCandidates<T extends { session_id: string; entry_id?: string; oversized_identity: number }>(
  db: ReturnType<DatabaseManager['getDb']>, query: string, params: unknown[], legacy = false,
): T[] {
  type CompactRow = { candidate_rowid: number; session_chars: number; entry_chars: number };
  const candidates = db.prepare(query).all(...params) as CompactRow[];
  let remaining = MAX_CANDIDATE_KEY_BYTES;
  for (const row of candidates) {
    if (row.session_chars > MAX_SEARCH_ID_CHARS || (!legacy && row.entry_chars > MAX_SEARCH_ID_CHARS)) throw new SessionSearchReadLimitError();
    // SQLite counts code points; four bytes cover the largest UTF-16 representation.
    remaining -= 4 * (row.session_chars + (legacy ? 0 : row.entry_chars));
    if (remaining < 0) throw new SessionSearchReadLimitError();
  }
  const byRow = new Map<number, T>();
  for (let offset = 0; offset < candidates.length; offset += 64) {
    const batch = candidates.slice(offset, offset + 64);
    const sameSizes = `length(m.session_id) <= wanted.session_chars${legacy ? '' : ' AND m.entry_id IS NOT NULL AND length(m.entry_id) <= wanted.entry_chars'}`;
    const fields = legacy
      ? `substr(s.project, 1, 1000) AS project, substr(m.role, 1, 200) AS role, substr(m.content, 1, ${MAX_SNIPPET_CHARS}) AS content, length(m.content) AS content_chars, substr(m.timestamp, 1, 200) AS timestamp`
      : `CASE WHEN ${sameSizes} THEN m.entry_id ELSE '' END AS entry_id, substr(m.role, 1, 200) AS role, substr(m.kind, 1, 200) AS kind, substr(m.timestamp, 1, 200) AS timestamp`;
    // Recheck sizes in SQL: a concurrent index change must not bypass the first budget.
    const rows = db.prepare(`SELECT m.rowid AS candidate_rowid, CASE WHEN ${sameSizes} THEN m.session_id ELSE '' END AS session_id,
        CASE WHEN ${sameSizes} THEN 0 ELSE 1 END AS oversized_identity, ${fields}
      FROM (${batch.map((_, index) => index === 0 ? 'SELECT ? AS candidate_rowid, ? AS session_chars, ? AS entry_chars' : 'SELECT ?, ?, ?').join(' UNION ALL ')}) AS wanted
      JOIN messages m ON m.rowid = wanted.candidate_rowid JOIN sessions s ON s.id = m.session_id`)
      .all(...batch.flatMap(row => [row.candidate_rowid, row.session_chars, row.entry_chars])) as Array<T & { candidate_rowid: number }>;
    for (const row of rows) {
      if (row.oversized_identity) throw new SessionSearchReadLimitError();
      byRow.set(row.candidate_rowid, row);
    }
  }
  // Payload fetch order is irrelevant; preserve the original ranked candidate order.
  return candidates.flatMap(row => { const value = byRow.get(row.candidate_rowid); return value ? [value] : []; });
}

/** Original FTS/LIKE search. Its ordering and result shape are intentionally unchanged. */
export function searchSessions(dbManager: DatabaseManager, query: string, options: SessionSearchOptions = {}): SessionSearchResult[] {
  dbManager.assertSessionEvidenceAvailable();
  if (query.trim().length === 0) return [];
  const db = dbManager.getDb();
  const { project, role, since } = options;
  const limit = Math.min(Math.max(Number.isFinite(options.limit) ? Math.floor(options.limit!) : 10, 1), 20);
  const budget = { remainingBytes: SESSION_SEARCH_MAX_SCAN_BYTES };
  const canonicalCache = new Map<string, boolean>();
  const hasCanonical = (sessionId: string): boolean => {
    if (!canonicalCache.has(sessionId)) {
      canonicalCache.set(sessionId, canonicalSessionOwners(db, sessionId, options.sessionsDir, file => {
        const session = parseSessionFileForSearch(file, { sessionId, budget });
        return session ? boundSessionForSearch(session, options.project) : null;
      }, true).length > 0);
    }
    return canonicalCache.get(sessionId)!;
  };
  let ftsParseError = false;
  const executeSearch = (match: SearchMatch): SessionSearchResult[] => {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (match.type === 'fts') {
      conditions.push('m.rowid IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ?)');
      params.push(match.query);
    } else {
      if (match.terms.length === 0) return [];
      conditions.push(`(${match.terms.map(() => `m.content LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      for (const term of match.terms) params.push(`%${escapeLikePattern(term)}%`);
    }
    if (project) { conditions.push('s.project = ?'); params.push(project); }
    if (role) { conditions.push('m.role = ?'); params.push(role); }
    if (since) { conditions.push('m.timestamp >= ?'); params.push(since); }
    try {
      // Bound payloads inside SQLite: a row limit does not bound large messages,
      // and selecting content twice creates two independent V8 strings.
      const rows = readSearchCandidates(db, `SELECT ${COMPACT_CANDIDATE_FIELDS} FROM messages m JOIN sessions s ON s.id = m.session_id WHERE ${conditions.join(' AND ')} ORDER BY m.timestamp DESC LIMIT ?`, [...params, Math.max(limit * 20, limit)], true) as Array<{ session_id: string; oversized_identity: number; project: string; role: string; content: string; timestamp: string; content_chars: number }>;
      const visible: typeof rows = [];
      for (const row of rows) {
        if (options.sessionsDir && !hasCanonical(row.session_id)) continue;
        visible.push(row);
        if (visible.length >= limit) break;
      }
      return mapRows(visible);
    } catch (err) {
      if (match.type === 'fts' && isFts5QueryError(err)) { ftsParseError = true; return []; }
      throw err;
    }
  };
  const normalizedQuery = normalizeFts5Query(query);
  if (!normalizedQuery) return [];
  const exactResults = executeSearch({ type: 'fts', query: normalizedQuery });
  if (exactResults.length > 0) return exactResults;
  if (hasExplicitFts5Operator(query)) {
    if (!ftsParseError) return exactResults;
    const nlQuery = normalizeNaturalLanguageFts5Query(query);
    if (nlQuery && nlQuery !== normalizedQuery) {
      const nlResults = executeSearch({ type: 'fts', query: nlQuery });
      if (nlResults.length > 0) return nlResults;
      const nlFallback = buildNaturalLanguageFallbackQuery(query);
      if (nlFallback && nlFallback !== nlQuery) {
        const fallbackResults = executeSearch({ type: 'fts', query: nlFallback });
        if (fallbackResults.length > 0) return fallbackResults;
      }
    }
    return executeSearch({ type: 'like', terms: collectLikeTerms(query) });
  }
  const fallbackQuery = buildFallbackFts5Query(query);
  if (fallbackQuery && fallbackQuery !== normalizedQuery) {
    const fallbackResults = executeSearch({ type: 'fts', query: fallbackQuery });
    if (fallbackResults.length > 0) return fallbackResults;
  }
  return executeSearch({ type: 'like', terms: collectLikeTerms(query) });
}

function codePointOffset(text: string, count: number): number {
  let offset = 0;
  for (let index = 0; index < count && offset < text.length; index++) {
    offset += text.codePointAt(offset)! > 0xffff ? 2 : 1;
  }
  return offset;
}

function codePointCount(text: string): number {
  let count = 0;
  for (let offset = 0; offset < text.length; count++) offset += text.codePointAt(offset)! > 0xffff ? 2 : 1;
  return count;
}

/** Detach small excerpts so a V8 sliced string cannot keep its large source alive. */
function copyText(text: string): string {
  return Buffer.from(text, 'utf16le').toString('utf16le');
}

function truncateCodePoints(text: string, maxChars: number): string {
  return copyText(text.slice(0, codePointOffset(text, maxChars)));
}

/** Map a folded UTF-16 offset back to its original prefix without a per-character map. */
function originalHitOffset(text: string, foldedOffset: number): number {
  const guess = Math.min(foldedOffset, text.length);
  if (text.slice(0, guess).toLocaleLowerCase().length === foldedOffset) return guess;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (text.slice(0, middle).toLocaleLowerCase().length <= foldedOffset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Center a Unicode-safe excerpt without materializing an array of the entire message. */
function safeSnippet(text: string, query: string, maxChars: number): string {
  const length = codePointCount(text);
  if (length <= maxChars) return copyText(text);
  const lowerText = text.toLocaleLowerCase();
  const hitOffsets = collectLikeTerms(query)
    .map(term => lowerText.indexOf(term.toLocaleLowerCase()))
    .filter(offset => offset >= 0)
    .sort((a, b) => a - b);
  const foldedHit = hitOffsets[0];
  if (foldedHit === undefined) return truncateCodePoints(text, maxChars);
  const hit = codePointCount(text.slice(0, originalHitOffset(text, foldedHit)));
  const leadingMarker = hit > 0 ? '…' : '';
  const trailingMarker = hit < length - maxChars ? '…' : '';
  const contentBudget = maxChars - leadingMarker.length - trailingMarker.length;
  const start = Math.max(0, Math.min(hit - Math.floor(contentBudget / 3), length - contentBudget));
  return copyText(`${leadingMarker}${text.slice(codePointOffset(text, start), codePointOffset(text, start + contentBudget))}${trailingMarker}`);
}

type CanonicalSearchEntry = ParsedEntry & { searchScore: number; searchMatchesFilters: boolean };
type CanonicalSearchSession = ParsedSession & { searchMatchesProject: boolean; searchIsService: boolean };

function resolveSessionFilter(db: ReturnType<DatabaseManager['getDb']>, value: string | undefined): { ids?: string[]; ambiguous: string[] } {
  if (!value) return { ambiguous: [] };
  const rows = db.prepare(`SELECT substr(id, 1, ${MAX_SEARCH_ID_CHARS}) AS id, length(id) > ${MAX_SEARCH_ID_CHARS} AS oversized_identity FROM sessions WHERE id = ? OR id LIKE ? ORDER BY id LIMIT 21`).all(value, `${escapeLikePattern(value)}%`) as Array<{ id: string; oversized_identity: number }>;
  if (rows.some(row => row.oversized_identity)) throw new SessionSearchReadLimitError();
  const ids = rows.map(row => row.id);
  return ids.length === 1 ? { ids, ambiguous: [] } : { ids: [], ambiguous: ids.slice(0, 20) };
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let result = '';
  for (const character of text) {
    if (Buffer.byteLength(result + character, 'utf8') > maxBytes) break;
    result += character;
  }
  return result;
}

function isServiceSession(name: string | null): boolean {
  if (!name?.trim()) return false;
  return /(?:^|[\s:_-])(service|consolidation)(?:$|[\s:_-])/i.test(name.trim()) || /^(?:service|consolidation)$/i.test(name.trim());
}

/** Classify full canonical metadata before retaining only detached display fields. */
function boundSessionForSearch(session: ParsedSession, project?: string): CanonicalSearchSession {
  return {
    ...session,
    searchMatchesProject: !project || session.project === project,
    searchIsService: isServiceSession(session.name ?? null),
    project: truncateCodePoints(session.project, 1_000),
    cwd: truncateCodePoints(session.cwd, 2_000),
    name: session.name == null ? null : truncateCodePoints(session.name, 1_000),
    title: null, metadata: null, startedAt: truncateCodePoints(session.startedAt, 200),
  };
}

function canonicalEligibleForRow(row: { session_id: string }, options: SessionSearchEvidenceOptions): boolean {
  if (row.session_id === options.currentSessionId) return options.includeCurrentSession === true;
  return true;
}

/**
 * Structured, canonical-openable evidence search. Candidates are over-fetched,
 * checked against JSONL, then limited, so stale/live rows never consume slots.
 */
export function searchSessionEvidence(dbManager: DatabaseManager, query: string, options: SessionSearchEvidenceOptions = {}): SessionSearchEvidenceOutcome {
  dbManager.assertSessionEvidenceAvailable();
  if (!query.trim()) return { results: [], ambiguousSessionIds: [] };
  const db = dbManager.getDb();
  const requestedLimit = Number.isFinite(options.limit) ? Math.floor(options.limit as number) : DEFAULT_EVIDENCE_LIMIT;
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_EVIDENCE_LIMIT);
  const snippetChars = Math.min(Math.max(Math.floor(options.snippetChars ?? DEFAULT_SNIPPET_CHARS), 80), MAX_SNIPPET_CHARS);
  const resolved = resolveSessionFilter(db, options.sessionId);
  if (options.sessionId && !resolved.ids?.length) return { results: [], ambiguousSessionIds: resolved.ambiguous };
  const terms = collectLikeTerms(query);
  const normalized = normalizeFts5Query(query);
  type CandidateRow = { session_id: string; entry_id: string; oversized_identity: number; role: string; kind: string; timestamp: string };
  const filterSql = `${resolved.ids?.length ? `AND m.session_id IN (${resolved.ids.map(() => '?').join(',')})` : ''} ${options.project ? 'AND s.project = ?' : ''} ${options.role ? 'AND m.role = ?' : ''} ${options.since ? 'AND m.timestamp >= ?' : ''}`;
  const filterParams = [...(resolved.ids ?? []), ...(options.project ? [options.project] : []), ...(options.role ? [options.role] : []), ...(options.since ? [options.since] : [])];
  let candidateRows: CandidateRow[];
  try {
    candidateRows = readSearchCandidates(db, `
      SELECT ${COMPACT_CANDIDATE_FIELDS}, bm25(message_fts) AS bm25_score
      FROM messages m JOIN sessions s ON s.id = m.session_id
      LEFT JOIN message_fts ON message_fts.rowid = m.rowid
      WHERE m.entry_id IS NOT NULL AND (m.rowid IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ?) OR ${terms.length ? terms.map(() => 'm.content LIKE ? ESCAPE \'\\\'').join(' OR ') : '0'}) ${filterSql}
      ORDER BY CASE WHEN bm25(message_fts) IS NULL THEN 1 ELSE 0 END, bm25_score ASC, m.timestamp DESC, m.session_id ASC, m.entry_id ASC
      LIMIT ?`, [normalized || '""', ...terms.map(term => `%${escapeLikePattern(term)}%`), ...filterParams, limit * 20]) as CandidateRow[];
  } catch (error) {
    if (error instanceof SessionSearchReadLimitError) throw error;
    // Malformed MATCH expressions are untrusted input; use a bounded LIKE candidate scan.
    if (!terms.length) return { results: [], ambiguousSessionIds: [] };
    candidateRows = readSearchCandidates(db, `
      SELECT ${COMPACT_CANDIDATE_FIELDS}, NULL AS bm25_score
      FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE m.entry_id IS NOT NULL AND (${terms.map(() => 'm.content LIKE ? ESCAPE \'\\\'').join(' OR ')}) ${filterSql}
      ORDER BY m.timestamp DESC, m.session_id ASC, m.entry_id ASC LIMIT ?`, [...terms.map(term => `%${escapeLikePattern(term)}%`), ...filterParams, limit * 20]) as CandidateRow[];
  }
  const requestedEntries = new Map<string, Set<string>>();
  for (const row of candidateRows) {
    if (!requestedEntries.has(row.session_id)) requestedEntries.set(row.session_id, new Set());
    requestedEntries.get(row.session_id)!.add(row.entry_id);
  }
  const budget = { remainingBytes: SESSION_SEARCH_MAX_SCAN_BYTES };
  const canonicalCache = new Map<string, CanonicalSearchSession | null>();
  const resolveCanonical = (sessionId: string): CanonicalSearchSession | null => {
    if (!canonicalCache.has(sessionId)) {
      const owner = canonicalSessionOwners(db, sessionId, options.sessionsDir, file => {
        const session = parseSessionFileForSearch(file, {
          sessionId, budget, entryIds: requestedEntries.get(sessionId),
          transformEntry: entry => ({
            ...entry,
            searchMatchesFilters: (!options.role || entry.role === options.role) && (!options.since || (entry.timestamp !== null && entry.timestamp >= options.since)),
            searchScore: terms.reduce((sum, term) => sum + (entry.content.toLocaleLowerCase().includes(term.toLocaleLowerCase()) ? 1 : 0), 0),
            content: safeSnippet(entry.content, query, snippetChars),
            timestamp: entry.timestamp === null ? null : truncateCodePoints(entry.timestamp, 200),
            toolName: entry.toolName == null ? null : truncateCodePoints(entry.toolName, 500),
            toolCallId: entry.toolCallId == null ? null : truncateCodePoints(entry.toolCallId, 500),
            toolCalls: undefined, parentId: null, parentEntryId: null,
          }),
        });
        return session ? boundSessionForSearch(session, options.project) : null;
      }, true)[0];
      canonicalCache.set(sessionId, (owner?.session as CanonicalSearchSession | undefined) ?? null);
    }
    return canonicalCache.get(sessionId)!;
  };
  const results: SessionSearchEvidence[] = [];
  const hitsBySession = new Map<string, number>();
  for (const row of candidateRows) {
    if (!canonicalEligibleForRow(row, options)) continue;
    const canonicalSession = resolveCanonical(row.session_id);
    const canonical = canonicalSession?.entries?.find(entry => entry.entryId === row.entry_id && entry.identityStatus !== 'ambiguous' && entry.identityStatus !== 'unresolvable') as CanonicalSearchEntry | undefined;
    if (!canonicalSession || !canonical || !canonicalSession.searchMatchesProject || !canonical.searchMatchesFilters) continue;
    // Privacy classification is derived from the current JSONL, never from
    // stale SQLite kind/tool/name metadata.
    const isTool = Boolean(canonical.toolName) || canonical.kind === 'tool_result' || canonical.kind === 'tool_call';
    const isService = (canonical.kind !== 'message' && !isTool) || canonicalSession.searchIsService;
    if (isService && !options.includeService) continue;
    if (isTool && !options.includeToolOutput) continue;
    // SQLite is only a candidate index. Publish the canonical payload and reject
    // rows whose old indexed content no longer matches the requested evidence.
    if (terms.length && !canonical.searchScore) continue;
    const sessionHits = hitsBySession.get(row.session_id) ?? 0;
    if (sessionHits >= MAX_HITS_PER_SESSION) continue;
    hitsBySession.set(row.session_id, sessionHits + 1);
    results.push({
      sessionId: row.session_id, entryId: row.entry_id, project: truncateCodePoints(canonicalSession.project, 1_000), cwd: truncateCodePoints(canonicalSession.cwd, 2_000), name: canonicalSession.name === null || canonicalSession.name === undefined ? null : truncateCodePoints(canonicalSession.name, 1_000),
      role: canonical.role ?? row.role, kind: canonical.kind ?? row.kind, tool: canonical.toolName === null || canonical.toolName === undefined ? null : truncateCodePoints(canonical.toolName, 500), tool_call_id: canonical.toolCallId === null || canonical.toolCallId === undefined ? null : truncateCodePoints(canonical.toolCallId, 500), timestamp: canonical.timestamp ?? row.timestamp,
      snippet: canonical.content, score: canonical.searchScore, scoreMode: 'like',
      anchor: `pi://session/${row.session_id}#entry=${row.entry_id}`,
    });
  }
  results.sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp) || a.sessionId.localeCompare(b.sessionId) || a.entryId.localeCompare(b.entryId));
  return { results: results.slice(0, limit), ambiguousSessionIds: [] };
}

/** Return the total number of indexed messages. */
export function getIndexedMessageCount(dbManager: DatabaseManager): number {
  const result = dbManager.getDb().prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
  return result.count;
}

export const SESSION_SEARCH_EVIDENCE_MAX_BYTES = MAX_EVIDENCE_BYTES;
export function capEvidenceOutput(text: string): string { return truncateUtf8(text, MAX_EVIDENCE_BYTES); }
