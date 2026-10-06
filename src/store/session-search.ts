import { DatabaseManager, getDatabaseCtor } from './db.js';
import { parseSessionFileForSearch, SessionSearchReadLimitError, SESSION_SEARCH_MAX_SCAN_BYTES, type ParsedEntry, type ParsedSession } from './session-parser.js';
import { canonicalSessionOwners, closePinnedSessionRoot, openPinnedSessionRoot, type PinnedSessionRoot } from './session-indexer.js';
import {
  buildFallbackFts5Query,
  buildNaturalLanguageFallbackQuery,
  collectLikeTerms,
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
  /** Canonical logical entry identity when the search was validated against JSONL. */
  entryId?: string;
  /** Original SQLite character count, before the bounded payload projection. */
  contentChars?: number;
}

export interface SessionSearchOptions {
  limit?: number;
  project?: string;
  role?: string;
  since?: string;
  /** Exact session ID filter; unlike a prefix it is never guessed. */
  sessionId?: string;
  /** Configured JSONL root used to reject stale/outside owners. */
  sessionsDir?: string;
  /** Exclude the active transcript unless explicitly requested. */
  includeCurrentSession?: boolean;
  currentSessionId?: string;
  /** Keep service and tool records opt-in for ordinary conversation search. */
  includeService?: boolean;
  includeToolOutput?: boolean;
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

function mapRows(rows: Array<{ session_id: string; entry_id?: string; project: string; role: string; content: string; timestamp: string; content_chars: number }>): SessionSearchResult[] {
  return rows.map(row => ({ sessionId: row.session_id, project: row.project, role: row.role, content: row.content, timestamp: row.timestamp, snippet: row.content, ...(row.entry_id ? { entryId: row.entry_id } : {}), contentChars: row.content_chars }));
}

/** Budget compact key sizes before materializing exact keys through any SQLite adapter. */
function readSearchCandidates<T extends { session_id: string; entry_id?: string; oversized_identity: number }>(
  db: ReturnType<DatabaseManager['getDb']>, query: string, params: unknown[], legacy = false, canonicalLegacy = false,
  window?: { limit: number; hasMore: boolean }, keyBudget: { remainingBytes: number } = { remainingBytes: MAX_CANDIDATE_KEY_BYTES },
 ): T[] {
  type CompactRow = { candidate_rowid: number; session_chars: number; entry_chars: number };
  const exactEntryIdentity = !legacy || canonicalLegacy;
  const compact = db.prepare(query).all(...params) as CompactRow[];
  // Only numeric metadata from the extra row detects exhaustion; its keys/payload are never read.
  if (window) window.hasMore = compact.length > window.limit;
  const candidates = window ? compact.slice(0, window.limit) : compact;
  let remaining = keyBudget.remainingBytes;
  for (const row of candidates) {
    if (row.session_chars > MAX_SEARCH_ID_CHARS || (exactEntryIdentity && row.entry_chars > MAX_SEARCH_ID_CHARS)) throw new SessionSearchReadLimitError();
    // SQLite counts code points; four bytes cover the largest UTF-16 representation.
    remaining -= 4 * (row.session_chars + (exactEntryIdentity ? row.entry_chars : 0));
    if (remaining < 0) throw new SessionSearchReadLimitError();
  }
  keyBudget.remainingBytes = remaining;
  const byRow = new Map<number, T>();
  for (let offset = 0; offset < candidates.length; offset += 64) {
    const batch = candidates.slice(offset, offset + 64);
    const sameSizes = `length(m.session_id) <= wanted.session_chars${exactEntryIdentity ? ' AND m.entry_id IS NOT NULL AND length(m.entry_id) <= wanted.entry_chars' : ''}`;
    const fields = legacy
      ? `${canonicalLegacy ? `CASE WHEN ${sameSizes} THEN m.entry_id ELSE '' END AS entry_id, ` : ''}substr(s.project, 1, 1000) AS project, substr(m.role, 1, 200) AS role, ${canonicalLegacy ? "'' AS content, 0 AS content_chars" : `substr(m.content, 1, ${MAX_SNIPPET_CHARS}) AS content, length(m.content) AS content_chars`}, substr(m.timestamp, 1, 200) AS timestamp`
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

type CanonicalOwner = ReturnType<typeof canonicalSessionOwners>[number];
type CanonicalSnapshot = { owners: CanonicalOwner[]; entries: Map<string, ParsedEntry>; validatedIds: Set<string> };
type CanonicalSessionResolver = (sessionId: string) => CanonicalSnapshot;
type EntryIdsProvider = (sessionId: string) => ReadonlySet<string> | undefined;

/** Cache canonical JSONL validation for the duration of one search operation. */
function createCanonicalSessionResolver(
  db: ReturnType<DatabaseManager['getDb']>,
  sessionsDir: string | undefined,
  readSession: (filePath: string, sessionId: string) => ParsedSession | null,
  pinnedDirectory?: PinnedSessionRoot,
  entryIdsProvider?: EntryIdsProvider,
 ): CanonicalSessionResolver {
  const cache = new Map<string, CanonicalSnapshot>();
  return (sessionId: string): CanonicalSnapshot => {
    const wanted = entryIdsProvider?.(sessionId);
    const cached = cache.get(sessionId);
    if (cached && (!wanted || [...wanted].every((entryId) => cached.validatedIds.has(entryId)))) return cached;
    const owners = canonicalSessionOwners(db, sessionId, sessionsDir, file => readSession(file, sessionId), true, undefined, pinnedDirectory);
    const entries = new Map<string, ParsedEntry>();
    const owner = owners[0];
    for (const entry of owner?.session.entries ?? []) {
      if (!entry.entryId || entry.identityStatus === 'ambiguous' || entry.identityStatus === 'unresolvable' || entries.has(entry.entryId)) continue;
      entries.set(entry.entryId, entry);
    }
    const snapshot = { owners, entries, validatedIds: new Set(wanted ?? entries.keys()) };
    cache.set(sessionId, snapshot);
    return snapshot;
  };
}

/** A supplied blank ID is invalid, not permission to widen the session scope. */
function assertSessionFilter(sessionId: string | undefined): void {
  if (sessionId !== undefined && !sessionId.trim()) {
    throw Object.assign(new Error('sessionId must be non-empty when provided; omit it for unrestricted session scope.'), { name: 'SessionSearchInvalidRequestError', code: 'INVALID_SESSION_ID' });
  }
}

/** Original FTS/LIKE search. Its ordering and result shape are intentionally unchanged. */
export function searchSessions(dbManager: DatabaseManager, query: string, options: SessionSearchOptions = {}): SessionSearchResult[] {
  assertSessionFilter(options.sessionId);
  dbManager.assertSessionEvidenceAvailable();
  if (query.trim().length === 0) return [];
  const db = dbManager.getDb();
  const { project, role, since } = options;
  const limit = Math.min(Math.max(Number.isFinite(options.limit) ? Math.floor(options.limit!) : 10, 1), 20);
  const budget = { remainingBytes: SESSION_SEARCH_MAX_SCAN_BYTES };
  const sharedPinnedRoot: PinnedSessionRoot | undefined = options.sessionsDir ? (openPinnedSessionRoot(options.sessionsDir) ?? undefined) : undefined;
  if (options.sessionsDir && !sharedPinnedRoot) return [];
  let ftsParseError = false;
  let canonicalQueryMatched = false;
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
    // Indexed facts may be stale; canonical searches filter only after JSONL validation.
    if (options.sessionId) { conditions.push('m.session_id = ?'); params.push(options.sessionId); }
    if (!options.sessionsDir) {
      if (project) { conditions.push('s.project = ?'); params.push(project); }
      if (role) { conditions.push('m.role = ?'); params.push(role); }
      if (since) { conditions.push('m.timestamp >= ?'); params.push(since); }
    }
    // A canonical search cannot publish an ownerless row; reject it before sorting/over-fetch.
    if (options.sessionsDir) conditions.push("m.entry_id IS NOT NULL AND m.entry_id <> '' AND EXISTS (SELECT 1 FROM session_files owned WHERE owned.session_id = m.session_id)");
    let verifier: InstanceType<ReturnType<typeof getDatabaseCtor>> | undefined;
    try {
      // Bound payloads inside SQLite: a row limit does not bound large messages,
      // and selecting content twice creates two independent V8 strings.
      type LegacyRow = { candidate_rowid: number; session_id: string; entry_id?: string; oversized_identity: number; project: string; role: string; content: string; timestamp: string; content_chars: number };
      const canonicalSearch = Boolean(options.sessionsDir);
      if (!canonicalSearch) {
        if (options.currentSessionId && !options.includeCurrentSession) { conditions.push('s.id <> ?'); params.push(options.currentSessionId); }
        if (!options.includeToolOutput) conditions.push("coalesce(m.kind, 'message') NOT IN ('tool_call', 'tool_result')");
        if (!options.includeService) conditions.push("coalesce(m.kind, 'message') = 'message'");
      }
      const candidateKeyBudget = { remainingBytes: MAX_CANDIDATE_KEY_BYTES };
      const batchSize = canonicalSearch ? Math.max(64, limit * 4) : limit * 20;
      const bySession = new Map<string, Set<string>>();
      const addRequested = (rows: LegacyRow[]) => {
        for (const row of rows) {
          if (!row.entry_id) continue;
          if (!bySession.has(row.session_id)) bySession.set(row.session_id, new Set());
          bySession.get(row.session_id)!.add(row.entry_id);
        }
      };
      // One transient row verifies full canonical text with the actual trigram
      // MATCH/LIKE semantics. It never writes the indexed database, and no full
      // payload survives the parser callback or escapes the search process.
      if (canonicalSearch) {
        const Sqlite = getDatabaseCtor(false);
        verifier = new Sqlite(':memory:');
        verifier.exec("CREATE VIRTUAL TABLE canonical_match USING fts5(content, tokenize='trigram')");
      }
      const insertCanonical = verifier?.prepare('INSERT INTO canonical_match(rowid, content) VALUES (1, ?)');
      const deleteCanonical = verifier?.prepare('DELETE FROM canonical_match WHERE rowid = 1');
      const checkCanonical = verifier?.prepare(match.type === 'fts'
        ? 'SELECT 1 FROM canonical_match WHERE canonical_match MATCH ? LIMIT 1'
        : `SELECT 1 FROM canonical_match WHERE ${match.terms.map(() => "content LIKE ? ESCAPE '\\'").join(' OR ')} LIMIT 1`);
      const matchParams = match.type === 'fts' ? [match.query] : match.terms.map(term => `%${escapeLikePattern(term)}%`);
      const resolveCanonical = canonicalSearch ? createCanonicalSessionResolver(db, options.sessionsDir, (file, sessionId) => {
        const session = parseSessionFileForSearch(file, {
          sessionId, budget, entryIds: bySession.get(sessionId),
          transformEntry: entry => {
            deleteCanonical!.run();
            insertCanonical!.run(entry.content);
            const matchesQuery = Boolean(checkCanonical!.get(...matchParams));
            deleteCanonical!.run();
            return {
              ...entry, matchesQuery,
              matchesFilters: (!role || entry.role === role) && (!since || (entry.timestamp !== null && entry.timestamp >= since)),
              contentChars: codePointCount(entry.content), content: truncateCodePoints(entry.content, MAX_SNIPPET_CHARS),
              timestamp: entry.timestamp === null ? null : truncateCodePoints(entry.timestamp, 200),
              toolName: entry.toolName == null ? null : truncateCodePoints(entry.toolName, 500), toolCallId: entry.toolCallId == null ? null : truncateCodePoints(entry.toolCallId, 500), toolCalls: undefined, parentId: null, parentEntryId: null,
            };
          },
        });
        return session ? boundSessionForSearch(session, project) : null;
      }, sharedPinnedRoot, sessionId => bySession.get(sessionId)) : null;
      const visible: LegacyRow[] = [];
      let offset = 0;
      for (;;) {
        const page = readSearchCandidates(db, `SELECT ${COMPACT_CANDIDATE_FIELDS} FROM messages m JOIN sessions s ON s.id = m.session_id WHERE ${conditions.join(' AND ')} ORDER BY m.timestamp DESC LIMIT ?${canonicalSearch ? ' OFFSET ?' : ''}`, canonicalSearch ? [...params, batchSize, offset] : [...params, batchSize], true, canonicalSearch, undefined, candidateKeyBudget) as LegacyRow[];
        if (!page.length) break;
        addRequested(page);
        for (const row of page) {
          if (resolveCanonical) {
            const snapshot = resolveCanonical(row.session_id);
            const session = snapshot.owners[0]?.session as CanonicalSearchSession | undefined;
            const entry = snapshot.entries.get(row.entry_id!) as (ParsedEntry & { contentChars: number; matchesFilters: boolean; matchesQuery: boolean }) | undefined;
            if (!session || !entry) continue;
            if (!session.searchMatchesProject || !entry.matchesFilters) continue;
            // A privacy-excluded canonical match is not a query miss; do not rescan it with weaker fallbacks.
            if (entry.matchesQuery) canonicalQueryMatched = true;
            if (row.session_id === options.currentSessionId && !options.includeCurrentSession) continue;
            const isTool = Boolean(entry.toolName) || entry.kind === 'tool_result' || entry.kind === 'tool_call';
            const isService = (entry.kind !== 'message' && !isTool) || session.searchIsService;
            if (isService && !options.includeService) continue;
            if (isTool && !options.includeToolOutput) continue;
            if (!entry.matchesQuery) continue;
            visible.push({ ...row, project: session.project, role: entry.role ?? '', timestamp: entry.timestamp ?? '', content: entry.content, content_chars: entry.contentChars });
          } else visible.push(row);
          if (visible.length >= limit) break;
        }
        if (visible.length >= limit || !canonicalSearch || page.length < batchSize) break;
        offset += page.length;
      }
      return mapRows(visible.slice(0, limit));
    } catch (err) {
      if (match.type === 'fts' && isFts5QueryError(err)) { ftsParseError = true; return []; }
      throw err;
    } finally {
      verifier?.close();
    }
  };
  try {
  const normalizedQuery = normalizeFts5Query(query);
  if (normalizedQuery.length === 0) {
    return executeSearch({ type: 'like', terms: collectLikeTerms(query) });
  }
  const exactResults = executeSearch({ type: 'fts', query: normalizedQuery });
  if (exactResults.length > 0 || canonicalQueryMatched) return exactResults;
  if (hasExplicitFts5Operator(query)) {
    if (!ftsParseError) return exactResults;
    const nlQuery = normalizeNaturalLanguageFts5Query(query);
    if (nlQuery && nlQuery !== normalizedQuery) {
      const nlResults = executeSearch({ type: 'fts', query: nlQuery });
      if (nlResults.length > 0 || canonicalQueryMatched) return nlResults;
      const nlFallback = buildNaturalLanguageFallbackQuery(query);
      if (nlFallback && nlFallback !== nlQuery) {
        const fallbackResults = executeSearch({ type: 'fts', query: nlFallback });
        if (fallbackResults.length > 0 || canonicalQueryMatched) return fallbackResults;
      }
    }
    return executeSearch({ type: 'like', terms: collectLikeTerms(query) });
  }
  const fallbackQuery = buildFallbackFts5Query(query);
  if (fallbackQuery && fallbackQuery !== normalizedQuery) {
    const fallbackResults = executeSearch({ type: 'fts', query: fallbackQuery });
    if (fallbackResults.length > 0 || canonicalQueryMatched) return fallbackResults;
  }
  return executeSearch({ type: 'like', terms: collectLikeTerms(query) });
  } finally {
    if (sharedPinnedRoot) closePinnedSessionRoot(sharedPinnedRoot);
  }
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

function canonicalEvidence(
  db: ReturnType<DatabaseManager['getDb']>,
  sessionId: string,
  entryId: string,
  sessionsDir: string | undefined,
  resolveCanonical: CanonicalSessionResolver,
 ): { session: ParsedSession; entry: ParsedEntry } | null {
  const snapshot = resolveCanonical(sessionId);
  const owner = snapshot.owners[0];
  const entry = snapshot.entries.get(entryId);
  return owner && entry ? { session: owner.session, entry } : null;
}
type CanonicalSearchEntry = ParsedEntry & { searchScore: number; searchMatchesFilters: boolean; searchMatchesQuery: boolean };
type CanonicalSearchSession = ParsedSession & { searchMatchesProject: boolean; searchIsService: boolean };

function resolveSessionFilter(db: ReturnType<DatabaseManager['getDb']>, value: string | undefined): { ids?: string[]; ambiguous: string[] } {
  if (!value) return { ambiguous: [] };
  const exactRows = db.prepare(`SELECT substr(id, 1, ${MAX_SEARCH_ID_CHARS}) AS id, length(id) > ${MAX_SEARCH_ID_CHARS} AS oversized_identity FROM sessions WHERE id = ? LIMIT 1`).all(value) as Array<{ id: string; oversized_identity: number }>;
  if (exactRows.some(row => row.oversized_identity)) throw new SessionSearchReadLimitError();
  if (exactRows.length === 1) return { ids: [exactRows[0].id], ambiguous: [] };
  const rows = db.prepare(`SELECT substr(id, 1, ${MAX_SEARCH_ID_CHARS}) AS id, length(id) > ${MAX_SEARCH_ID_CHARS} AS oversized_identity FROM sessions WHERE id LIKE ? ESCAPE '\\' ORDER BY id LIMIT 21`).all(`${escapeLikePattern(value)}%`) as Array<{ id: string; oversized_identity: number }>;
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
  assertSessionFilter(options.sessionId);
  dbManager.assertSessionEvidenceAvailable();
  if (!query.trim()) return { results: [], ambiguousSessionIds: [] };
  const normalized = normalizeFts5Query(query);
  const terms = collectLikeTerms(query);
  // Query alternatives share the read budget and one descriptor-pinned root.
  const budget = { remainingBytes: SESSION_SEARCH_MAX_SCAN_BYTES };
  const sharedPinnedRoot: PinnedSessionRoot | undefined = options.sessionsDir ? (openPinnedSessionRoot(options.sessionsDir) ?? undefined) : undefined;
  if (options.sessionsDir && !sharedPinnedRoot) return { results: [], ambiguousSessionIds: [] };
  const queryState = { matched: false };
  const execute = (match: SearchMatch) => searchSessionEvidenceMatch(dbManager, query, options, match, budget, queryState, sharedPinnedRoot);
  try {
    const shortLiteral = !hasExplicitFts5Operator(query) && terms.length === 1 && codePointCount(terms[0]) < 3;
    if (!normalized || shortLiteral) return execute({ type: 'like', terms });
    const exact = execute({ type: 'fts', query: normalized });
    if (exact.results.length || queryState.matched || hasExplicitFts5Operator(query)) return exact;
    const fallback = buildFallbackFts5Query(query);
    if (fallback && fallback !== normalized) {
      const broader = execute({ type: 'fts', query: fallback });
      if (broader.results.length || queryState.matched) return broader;
    }
    return execute({ type: 'like', terms });
  } finally {
    if (sharedPinnedRoot) closePinnedSessionRoot(sharedPinnedRoot);
  }
}

/** Evaluate one query alternative against full canonical entries before projection. */
function searchSessionEvidenceMatch(
  dbManager: DatabaseManager, query: string, options: SessionSearchEvidenceOptions,
  initialMatch: SearchMatch, budget: { remainingBytes: number },
  queryState: { matched: boolean },
  sharedPinnedRoot?: PinnedSessionRoot,
  ): SessionSearchEvidenceOutcome {
  dbManager.assertSessionEvidenceAvailable();
  if (!query.trim()) return { results: [], ambiguousSessionIds: [] };
  const db = dbManager.getDb();
  const requestedLimit = Number.isFinite(options.limit) ? Math.floor(options.limit as number) : DEFAULT_EVIDENCE_LIMIT;
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_EVIDENCE_LIMIT);
  const snippetChars = Math.min(Math.max(Math.floor(options.snippetChars ?? DEFAULT_SNIPPET_CHARS), 80), MAX_SNIPPET_CHARS);
  const resolved = resolveSessionFilter(db, options.sessionId);
  if (options.sessionId && !resolved.ids?.length) return { results: [], ambiguousSessionIds: resolved.ambiguous };
  const terms = collectLikeTerms(query);
  type CandidateRow = { session_id: string; entry_id: string; oversized_identity: number; role: string; kind: string; timestamp: string };
  // Session identity is stable. Mutable project/role/date facts are checked in JSONL.
  const filterSql = resolved.ids?.length ? `AND m.session_id IN (${resolved.ids.map(() => '?').join(',')})` : '';
  const filterParams = resolved.ids ?? [];
  const canonicalSearch = Boolean(options.sessionsDir);
  const pageSize = canonicalSearch ? Math.max(64, limit * 4) : limit * 20;
  const candidateKeyBudget = { remainingBytes: MAX_CANDIDATE_KEY_BYTES };
  type CandidatePage = CandidateRow[];
  let canonicalMatch = initialMatch;
  const canonicalOwnershipSql = canonicalSearch ? 'AND EXISTS (SELECT 1 FROM session_files sf WHERE sf.session_id = m.session_id)' : '';
  const requestedEntries = new Map<string, Set<string>>();
  const addRequested = (rows: CandidatePage): void => {
    for (const row of rows) {
      if (!requestedEntries.has(row.session_id)) requestedEntries.set(row.session_id, new Set());
      requestedEntries.get(row.session_id)!.add(row.entry_id);
    }
  };
  const fetchPage = (offset: number): CandidatePage => readSearchCandidates(db, `
      SELECT ${COMPACT_CANDIDATE_FIELDS}, bm25(message_fts) AS bm25_score
      FROM messages m JOIN sessions s ON s.id = m.session_id
      LEFT JOIN message_fts ON message_fts.rowid = m.rowid
      WHERE m.entry_id IS NOT NULL AND (m.rowid IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ?) OR ${terms.length ? terms.map(() => 'm.content LIKE ? ESCAPE \'\\\'').join(' OR ') : '0'}) ${filterSql} ${canonicalOwnershipSql}
      ORDER BY CASE WHEN bm25(message_fts) IS NULL THEN 1 ELSE 0 END, bm25_score ASC, m.timestamp DESC, m.session_id ASC, m.entry_id ASC
      LIMIT ?${canonicalSearch ? ' OFFSET ?' : ''}`, canonicalSearch ? [canonicalMatch.type === 'fts' ? canonicalMatch.query : '""', ...terms.map(term => `%${escapeLikePattern(term)}%`), ...filterParams, pageSize, offset] : [canonicalMatch.type === 'fts' ? canonicalMatch.query : '""', ...terms.map(term => `%${escapeLikePattern(term)}%`), ...filterParams, pageSize], false, false, undefined, candidateKeyBudget) as CandidatePage;
  let candidateRows: CandidatePage;
  try {
    candidateRows = fetchPage(0);
  } catch (error) {
    if (!isFts5QueryError(error)) throw error;
    // Malformed MATCH expressions are untrusted input; use a bounded LIKE candidate scan.
    if (!terms.length) return { results: [], ambiguousSessionIds: [] };
    canonicalMatch = { type: 'like', terms };
    candidateRows = readSearchCandidates(db, `
      SELECT ${COMPACT_CANDIDATE_FIELDS}
      FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE m.entry_id IS NOT NULL AND (${terms.map(() => 'm.content LIKE ? ESCAPE \'\\\'').join(' OR ')}) ${filterSql} ${canonicalOwnershipSql}
      ORDER BY m.timestamp DESC, m.session_id ASC, m.entry_id ASC LIMIT ?${canonicalSearch ? ' OFFSET ?' : ''}`, canonicalSearch ? [...terms.map(term => `%${escapeLikePattern(term)}%`), ...filterParams, pageSize, 0] : [...terms.map(term => `%${escapeLikePattern(term)}%`), ...filterParams, pageSize], false, false, undefined, candidateKeyBudget) as CandidatePage;
  }
  addRequested(candidateRows);
  if (!candidateRows.length) return { results: [], ambiguousSessionIds: [] };
  const Sqlite = getDatabaseCtor(false);
  const verifier = new Sqlite(':memory:');
  try {
    // Reuse the legacy verifier's one-row trigram strategy. Full canonical text
    // is evaluated before projection; this database never touches the search index.
    verifier.exec("CREATE VIRTUAL TABLE canonical_match USING fts5(content, tokenize='trigram')");
    const insertCanonical = verifier.prepare('INSERT INTO canonical_match(rowid, content) VALUES (1, ?)');
    const deleteCanonical = verifier.prepare('DELETE FROM canonical_match WHERE rowid = 1');
    const checkCanonical = verifier.prepare(canonicalMatch.type === 'fts'
      ? 'SELECT 1 FROM canonical_match WHERE canonical_match MATCH ? LIMIT 1'
      : `SELECT 1 FROM canonical_match WHERE ${terms.length ? terms.map(() => "content LIKE ? ESCAPE '\\'").join(' OR ') : '0'} LIMIT 1`);
    const matchParams = canonicalMatch.type === 'fts' ? [canonicalMatch.query] : terms.map(term => `%${escapeLikePattern(term)}%`);
    const resolveCanonical = createCanonicalSessionResolver(db, options.sessionsDir, (file, sessionId) => {
      const session = parseSessionFileForSearch(file, {
        sessionId, budget, entryIds: requestedEntries.get(sessionId),
        transformEntry: entry => {
          deleteCanonical.run();
          insertCanonical.run(entry.content);
          const searchMatchesQuery = Boolean(checkCanonical.get(...matchParams));
          deleteCanonical.run();
          return {
            ...entry, searchMatchesQuery,
            searchMatchesFilters: (!options.role || entry.role === options.role) && (!options.since || (entry.timestamp !== null && entry.timestamp >= options.since)),
            searchScore: Math.max(1, terms.reduce((sum, term) => sum + (entry.content.toLocaleLowerCase().includes(term.toLocaleLowerCase()) ? 1 : 0), 0)),
            content: safeSnippet(entry.content, query, snippetChars),
            timestamp: entry.timestamp === null ? null : truncateCodePoints(entry.timestamp, 200),
            toolName: entry.toolName == null ? null : truncateCodePoints(entry.toolName, 500),
            toolCallId: entry.toolCallId == null ? null : truncateCodePoints(entry.toolCallId, 500),
            toolCalls: undefined, parentId: null, parentEntryId: null,
          };
        },
      });
      return session ? boundSessionForSearch(session, options.project) : null;
    }, sharedPinnedRoot, sessionId => requestedEntries.get(sessionId));
    const results: SessionSearchEvidence[] = [];
    const hitsBySession = new Map<string, number>();
    const processRows = (rows: CandidatePage): void => {
      for (const row of rows) {
        if (!canonicalEligibleForRow(row, options)) continue;
        const evidence = canonicalEvidence(db, row.session_id, row.entry_id, options.sessionsDir, resolveCanonical);
        if (!evidence) continue;
        const canonical = evidence.entry as CanonicalSearchEntry;
        const canonicalSession = evidence.session as CanonicalSearchSession;
        if (!canonicalSession.searchMatchesProject || !canonical.searchMatchesFilters) continue;
        if (canonical.searchMatchesQuery) queryState.matched = true;
        // Privacy classification is derived from the current JSONL, never from stale SQLite metadata.
        const isTool = Boolean(canonical.toolName) || canonical.kind === 'tool_result' || canonical.kind === 'tool_call';
        const isService = (canonical.kind !== 'message' && !isTool) || canonicalSession.searchIsService;
        if (isService && !options.includeService) continue;
        if (isTool && !options.includeToolOutput) continue;
        if (!canonical.searchMatchesQuery) continue;
        const sessionHits = hitsBySession.get(row.session_id) ?? 0;
        if (sessionHits >= MAX_HITS_PER_SESSION) continue;
        hitsBySession.set(row.session_id, sessionHits + 1);
        results.push({
          sessionId: row.session_id, entryId: row.entry_id, project: truncateCodePoints(canonicalSession.project, 1_000), cwd: truncateCodePoints(canonicalSession.cwd, 2_000), name: canonicalSession.name === null || canonicalSession.name === undefined ? null : truncateCodePoints(canonicalSession.name, 1_000),
          role: canonical.role ?? row.role, kind: canonical.kind ?? row.kind, tool: canonical.toolName === null || canonical.toolName === undefined ? null : truncateCodePoints(canonical.toolName, 500), tool_call_id: canonical.toolCallId === null || canonical.toolCallId === undefined ? null : truncateCodePoints(canonical.toolCallId, 500), timestamp: canonical.timestamp ?? '',
          snippet: canonical.content, score: canonical.searchScore, scoreMode: 'like', anchor: `pi://session/${row.session_id}#entry=${row.entry_id}`,
        });
      }
    };
    processRows(candidateRows);
    let offset = candidateRows.length;
    while (canonicalSearch && candidateRows.length === pageSize && results.length < limit) {
      candidateRows = fetchPage(offset);
      if (!candidateRows.length) break;
      addRequested(candidateRows);
      processRows(candidateRows);
      offset += candidateRows.length;
    }
    results.sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp) || a.sessionId.localeCompare(b.sessionId) || a.entryId.localeCompare(b.entryId));
    return { results: results.slice(0, limit), ambiguousSessionIds: [] };
  } finally {
    verifier.close();
  }
}

/** Return the total number of indexed messages. */
export function getIndexedMessageCount(dbManager: DatabaseManager): number {
  const result = dbManager.getDb().prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
  return result.count;
}

export const SESSION_SEARCH_EVIDENCE_MAX_BYTES = MAX_EVIDENCE_BYTES;
export function capEvidenceOutput(text: string): string { return truncateUtf8(text, MAX_EVIDENCE_BYTES); }
