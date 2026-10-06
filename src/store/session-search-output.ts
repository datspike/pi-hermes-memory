import type { SessionSearchResults, SessionSearchEvidenceOutcome } from './session-search.js';
import { SESSION_SEARCH_EVIDENCE_MAX_BYTES } from './session-search.js';
import type { SessionAnchorSearchResult } from './session-anchor-search.js';

export interface SessionSearchToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}
const textResult = (text: string, details: Record<string, unknown>): SessionSearchToolResult => ({
  content: [{ type: 'text', text }], details, ...(details.success === false ? { isError: true } : {}),
});
const MAX_LEGACY_OUTPUT_CHARS = 50 * 1024;
const PROJECT_SCOPE_MESSAGE = 'No readable contained registered session header matched this project filter. project refers to the conversation cwd, not the repository discussed in its messages. Remove an uncertain project filter and use a narrow query or exact session_id.';
const PARTIAL_SEARCH_MESSAGE = 'Search incomplete: the read limit was reached. These entries are canonically verified, but other matches may exist. Do not infer absence or the newest discussion across the whole archive. Narrow the query, use a session_id, or lower limit to 3.';

function capLegacyOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_LEGACY_OUTPUT_CHARS) return { text, truncated: false };
  const suffix = `\n... (output truncated, ${text.length} chars total — refine the query or lower the result limit)`;
  return { text: `${text.slice(0, MAX_LEGACY_OUTPUT_CHARS - suffix.length)}${suffix}`, truncated: true };
}

/** Distinguish authorship from tool/service records without guessing non-user means assistant. */
function legacyEntryLabel(result: SessionSearchResults[number]): string {
  const tool = result.toolName ? ` (${result.toolName.replace(/[\r\n|]/g, ' ')})` : '';
  if (result.kind === 'tool_result') return `🔧 Tool result${tool}`;
  if (result.kind === 'tool_call') return `🔧 Tool call${tool}`;
  if (result.toolName) return `🔧 Tool output${tool}`;
  if (result.kind && result.kind !== 'message') return `⚙️ Service (${result.kind.replace(/[\r\n|]/g, ' ')})`;
  if (result.role === 'user') return '👤 User';
  if (result.role === 'assistant') return '🤖 Assistant';
  if (result.role === 'system') return '⚙️ System';
  return '⚙️ Service';
}

/** Format in the child so the parent only decodes the bounded public response. */
export function formatLegacySearch(results: SessionSearchResults, totalMessages: number, query: string, requestedSnippetChars?: number): SessionSearchToolResult {
  if (totalMessages === 0 && !results.projectNotFound) {
    const message = 'No sessions indexed yet. Run /memory-index-sessions to import past sessions.';
    return textResult(message, { success: false, message });
  }
  if (!results.length) {
    const output = capLegacyOutput(results.projectNotFound ? PROJECT_SCOPE_MESSAGE : 'No results found. Try a different search term or broader query.');
    return textResult(output.text, { success: true, count: 0, message: output.text, outputChars: output.text.length, outputTruncated: output.truncated, ...(results.projectNotFound ? { projectNotFound: true } : {}) });
  }
  const snippetChars = Math.min(Math.max(Number.isFinite(requestedSnippetChars) ? Math.floor(requestedSnippetChars!) : 1_200, 100), 4_000);
  const blocks = [...(results.partial ? [PARTIAL_SEARCH_MESSAGE] : []), `Found ${results.length} results for "${query}":`];
  let truncatedCount = 0;
  for (const result of results) {
    const date = new Date(result.timestamp).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    const originalChars = result.contentChars ?? result.snippet.length;
    const truncated = result.snippet.length > snippetChars || originalChars > snippetChars;
    const snippet = truncated ? `${result.snippet.slice(0, snippetChars)}\n... (truncated, ${originalChars} chars total — refine the query or increase snippetChars)` : result.snippet;
    if (truncated) truncatedCount++;
    const anchor = result.entryId
      ? `🔗 session_id=${result.sessionId} entry_id=${result.entryId}`
      : `🔗 session_id=${result.sessionId}`;
    blocks.push(['---', `📅 ${date} | 📁 ${result.project} | ${legacyEntryLabel(result)}`, anchor, snippet].join('\n'));
  }
  const output = capLegacyOutput(blocks.join('\n\n').trim());
  return textResult(output.text, { success: true, count: results.length, truncatedCount, snippetChars, outputChars: output.text.length, outputTruncated: output.truncated, ...(results.partial ? { partial: true, partialReason: 'read_limit' } : {}) });
}

function structuredResponseLimitError(): Error {
  return Object.assign(new Error('Structured session search response exceeds 50 KiB; narrow the query or lower the result limit.'), { name: 'SessionSearchResponseLimitError', code: 'SESSION_SEARCH_RESPONSE_LIMIT' });
}

/** Build bounded JSONL evidence and retain details only for published entries. */
export function formatStructuredSearch(outcome: SessionSearchEvidenceOutcome): SessionSearchToolResult {
  if (outcome.ambiguousSessionIds.length > 0) {
    const candidates: string[] = [];
    for (const candidate of outcome.ambiguousSessionIds) {
      const next = [...candidates, candidate];
      if (Buffer.byteLength(JSON.stringify({ error: 'ambiguous_session_id', count: next.length, candidates: next }), 'utf8') > SESSION_SEARCH_EVIDENCE_MAX_BYTES) break;
      candidates.push(candidate);
    }
    return textResult(JSON.stringify({ error: 'ambiguous_session_id', count: candidates.length, candidates }), { success: false, count: candidates.length, candidates });
  }
  const lines = outcome.results.map(e => JSON.stringify({
    session_id: e.sessionId, entry_id: e.entryId, project: e.project, cwd: e.cwd, name: e.name,
    role: e.role, kind: e.kind, tool: e.tool, tool_call_id: e.tool_call_id, timestamp: e.timestamp, snippet: e.snippet,
    score: e.score, score_mode: e.scoreMode, anchor: e.anchor,
  }));
  let output = outcome.partial && outcome.results.length ? JSON.stringify({ type: 'search_status', partial: true, reason: 'read_limit', message: PARTIAL_SEARCH_MESSAGE }) : '';
  let count = 0;
  for (const line of lines) {
    const next = output ? `${output}\n${line}` : line;
    if (Buffer.byteLength(next, 'utf8') > SESSION_SEARCH_EVIDENCE_MAX_BYTES) {
      if (count === 0) throw structuredResponseLimitError();
      break;
    }
    output = next; count++;
  }
  const text = output || (outcome.projectNotFound ? PROJECT_SCOPE_MESSAGE : 'No results found.');
  return textResult(text, {
    success: true, count, outputBytes: Buffer.byteLength(text, 'utf8'), outputTruncated: count < lines.length,
    ...(outcome.partial && count ? { partial: true, partialReason: 'read_limit' } : {}),
    ...(outcome.projectNotFound ? { projectNotFound: true } : {}),
    sessionIds: [...new Set(outcome.results.slice(0, count).map(e => e.sessionId))],
  });
}

const MAX_ANCHOR_RESPONSE_BYTES = 1024 * 1024;

function anchorResponseLimitError(): Error {
  return Object.assign(new Error('Anchor session search response exceeds 1 MiB; narrow the query or lower the result limit.'), { name: 'SessionSearchResponseLimitError', code: 'SESSION_SEARCH_RESPONSE_LIMIT' });
}

/** Reject oversized flat metadata before materializing a potentially huge JSON string. */
function checkAnchorMetadataSize(search: SessionAnchorSearchResult): void {
  let bytes = Buffer.byteLength(search.message ?? '', 'utf8');
  if (bytes > MAX_ANCHOR_RESPONSE_BYTES) throw anchorResponseLimitError();
  for (const range of search.ranges) {
    for (const value of Object.values(range)) {
      if (typeof value === 'string') bytes += Buffer.byteLength(value, 'utf8');
      if (bytes > MAX_ANCHOR_RESPONSE_BYTES) throw anchorResponseLimitError();
    }
  }
}

/** Account for UTF-8, escaping, duplicated text and the actual success IPC envelope. */
function boundedAnchorResult(text: string, details: Record<string, unknown>): SessionSearchToolResult {
  const result = textResult(text, details);
  if (Buffer.byteLength(JSON.stringify({ type: 'result', ok: true, result }), 'utf8') > MAX_ANCHOR_RESPONSE_BYTES) throw anchorResponseLimitError();
  return result;
}

/** Render source line ranges with the existing anchor-mode response fields. */
export function formatAnchorSearch(search: SessionAnchorSearchResult): SessionSearchToolResult {
  checkAnchorMetadataSize(search);
  if (!search.success) {
    const message = search.message ?? 'Anchor session search failed.';
    return boundedAnchorResult(message, { success: false, message });
  }
  const lines = [`count: ${search.ranges.length}`];
  if (search.message) lines.push(`message: ${search.message}`);
  if (search.ranges.length) {
    lines.push('anchors:');
    for (const range of search.ranges) {
      const anchor = `${range.path}:${range.startLine}-${range.endLine}`;
      const oneLine = (range.reason ?? '').replace(/\s+/g, ' ').trim();
      const reason = oneLine.length <= 180 ? oneLine : `${oneLine.slice(0, 177)}...`;
      lines.push(reason ? `- ${anchor} — ${reason}` : `- ${anchor}`);
    }
  }
  const output = lines.join('\n');
  return boundedAnchorResult(output, { success: true, count: search.ranges.length, message: search.message, output, ranges: search.ranges });
}
