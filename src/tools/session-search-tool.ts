import * as path from 'node:path';
import type { ExtensionAPI, AgentToolUpdateCallback } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import type { DatabaseManager } from '../store/db.js';
import { runSessionSearch, type SessionSearchWorkerRequest, type SessionSearchExecutionOptions } from '../store/session-search-async.js';
import type { SessionSearchToolResult } from '../store/session-search-output.js';
import { normalizeSessionSearchSince, SessionSearchSinceError } from '../store/session-search-since.js';
import type { SessionSearchConfig } from '../types.js';
import { AGENT_ROOT } from '../paths.js';
import { createSharedToolResultRenderer } from './shared-output-view.js';
import { searchResultView } from './tool-result-views.js';

interface SessionSearchToolOptions {
  sessionsDir?: string;
  currentSessionId?: string | (() => string | undefined);
  timeoutMs?: number;
}
const DEFAULT_SESSIONS_DIR = path.join(AGENT_ROOT, 'sessions');
const DEFAULT_LEGACY_SNIPPET_CHARS = 1_200;
const MAX_LEGACY_SNIPPET_CHARS = 4_000;

type IndexedRequest = Omit<Extract<SessionSearchWorkerRequest, { mode: 'legacy' }>, 'dbPath'> | Omit<Extract<SessionSearchWorkerRequest, { mode: 'structured' }>, 'dbPath'>;
function invalidRequest(message: string, error?: string): SessionSearchToolResult {
  return { content: [{ type: 'text', text: message }], details: { success: false, message, ...(error ? { error } : {}) }, isError: true };
}
function executionOptions(options: SessionSearchToolOptions, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback): SessionSearchExecutionOptions {
  return { signal, timeoutMs: options.timeoutMs, onProgress: () => onUpdate?.({ content: [{ type: 'text', text: 'Searching sessions…' }], details: { success: true, phase: 'searching' } }) };
}
/** Check availability in the readonly child, never opening or repairing the managed DB here. */
async function executeIndexedSearch(dbManager: DatabaseManager, request: IndexedRequest, options: SessionSearchExecutionOptions): Promise<SessionSearchToolResult> {
  if (options.signal?.aborted) throw Object.assign(new Error('Session search cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
  try {
    const since = normalizeSessionSearchSince(request.options.since);
    return await runSessionSearch({ ...request, options: { ...request.options, since }, dbPath: dbManager.getPath() }, options);
  } catch (error) {
    if (error instanceof SessionSearchSinceError) return invalidRequest(error.message, error.code.toLowerCase());
    if (error instanceof Error && (error.name === 'SessionEvidenceUnavailableError' || (error as Error & { code?: string }).code === 'SESSION_EVIDENCE_UNAVAILABLE' || /migration pending|evidence unavailable/i.test(error.message))) {
      const result = { success: false, error: 'session_evidence_unavailable' };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result, isError: true };
    }
    throw error;
  }
}

export function registerSessionSearchTool(pi: ExtensionAPI, dbManager: DatabaseManager, config: SessionSearchConfig = { variant: 'legacy' }, options: SessionSearchToolOptions = {}): void {
  if (config.variant === 'anchors') { registerAnchorSessionSearchTool(pi, options); return; }
  if (config.variant === 'structured') { registerStructuredSessionSearchTool(pi, dbManager, options); return; }
  registerLegacySessionSearchTool(pi, dbManager, options);
}

function registerAnchorSessionSearchTool(pi: ExtensionAPI, options: SessionSearchToolOptions): void {
  const sessionsDir = options.sessionsDir ?? DEFAULT_SESSIONS_DIR;
  pi.registerTool({
    name: 'session_search', label: 'Session Search',
    description: `Search Pi session JSONL files in the opt-in anchor mode using a Markdown request.

This mode accepts only a markdown request. Supported scalar fields are from, to, cwd, and limit. Supported list sections are all, any, and exclude: all terms must match, any requires at least one listed term, and exclude removes matching ranges. It returns compact JSONL line-range anchors, not summaries or previews. Output is plain text: count, optional message, then anchors as path:startLine-endLine with a short reason. The complete response, including metadata, is limited to 1 MiB; exceeding it raises SESSION_SEARCH_RESPONSE_LIMIT without partial results. Narrow the query or lower limit to retry.

Example:
from: 2026-05-14
to: 2026-05-15
cwd: /path/to/project
limit: 20

all:
- alpha

any:
- beta
- gamma

exclude:
- delta`,
    promptSnippet: 'Search past session JSONL files for compact source anchors',
    promptGuidelines: [
      'Use session_search with markdown only when the session search anchor mode is configured.',
      'Before acting, search when a specific fact required for the next step is absent from current context but likely exists in the evicted part of the current session or another past session.',
      'Do not guess, repeat completed work, or ask the user to restate prior context before attempting a narrow search.',
      'Request source anchors, not summaries or previews.',
      'Use all for required terms, any for alternatives, and exclude for terms that must not appear in a returned range.',
    ],
    renderResult: createSharedToolResultRenderer(searchResultView),
    parameters: Type.Object({ markdown: Type.String({ description: 'Markdown request with optional from/to/cwd/limit fields and all/any/exclude lists.' }) }),
    execute: async (_id: string, args: { markdown: string }, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback) => {
      if (!args.markdown?.trim()) return invalidRequest('markdown is required');
      return runSessionSearch({ mode: 'anchors', markdown: args.markdown, sessionsDir }, executionOptions(options, signal, onUpdate));
    },
  });
}

function registerStructuredSessionSearchTool(pi: ExtensionAPI, dbManager: DatabaseManager, options: SessionSearchToolOptions): void {
  pi.registerTool({
    name: 'session_search', label: 'Session Search',
    description: 'Search canonical Pi session JSONL evidence. Results contain stable session_id and entry_id anchors that can be opened later with session_get. Current-session, service, and tool-output rows are opt-in.',
    promptSnippet: 'Search past sessions for canonical structured evidence',
    promptGuidelines: [
      'Use this mode when exact session evidence and an entry anchor are needed.',
      'Before acting, search when a specific fact required for the next step is absent from current context but likely exists in the evicted part of the current session or another past session.',
      'Do not guess, repeat completed work, or ask the user to restate prior context before attempting a narrow search.',
      'Pass include_current_session, include_service, or include_tool_output explicitly when those rows are required.',
      'Use session_get when exact canonical source context around a result is needed; copy session_id and entry_id as separate fields into session_get, never pass the pi:// anchor URI as entry_id.',
      'A successful recovery requires session_search followed by session_get for the exact entry; metadata or outline alone do not prove the requested fact.',
      'Inspect success:false and the error code in every tool result; failure is not an empty successful search.',
      'Use session_id for an exact ID or a bounded, unambiguous prefix; do not guess among ambiguous prefixes.',
      'project refers to the conversation cwd, not a repository mentioned in its messages; omit an uncertain project filter.',
      'A search_status JSONL record with partial:true means verified but incomplete evidence. It is not an entry anchor. Open returned entry records with session_get, but do not infer absence or the newest discussion across the entire archive.',
    ],
    renderResult: createSharedToolResultRenderer(searchResultView),
    parameters: Type.Object({
      query: Type.String({ description: 'Search terms.' }),
      session_id: Type.Optional(Type.String({ minLength: 1, pattern: '\\S', description: 'Non-blank exact session ID or an unambiguous prefix; omit this field for unrestricted session scope.' })),
      project: Type.Optional(Type.String({ description: 'Conversation project derived from its cwd, not a repository mentioned in messages; omit when uncertain.' })),
      role: Type.Optional(StringEnum(['user', 'assistant', 'system'] as const)),
      since: Type.Optional(Type.String({ description: 'Past YYYY-MM-DD (UTC midnight) or ISO timestamp with Z/offset, up to milliseconds. Invalid and future bounds are errors.' })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
      include_current_session: Type.Optional(Type.Boolean()),
      include_service: Type.Optional(Type.Boolean()),
      include_tool_output: Type.Optional(Type.Boolean()),
      snippet_chars: Type.Optional(Type.Number({ minimum: 80, maximum: 4000 })),
    }),
    execute: async (_id: string, args: { query: string; session_id?: string; project?: string; role?: string; since?: string; limit?: number; include_current_session?: boolean; include_service?: boolean; include_tool_output?: boolean; snippet_chars?: number }, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback) => {
      if (!args.query?.trim()) return invalidRequest('query is required');
      if (args.session_id !== undefined && !args.session_id.trim()) return invalidRequest('session_id must be non-empty when provided; omit it for unrestricted session scope.', 'invalid_session_id');
      const currentSessionId = typeof options.currentSessionId === 'function' ? options.currentSessionId() : options.currentSessionId;
      return executeIndexedSearch(dbManager, { mode: 'structured', query: args.query, options: {
        sessionId: args.session_id, project: args.project, role: args.role, since: args.since, limit: args.limit, sessionsDir: options.sessionsDir,
        currentSessionId, includeCurrentSession: args.include_current_session === true, includeService: args.include_service === true,
        includeToolOutput: args.include_tool_output === true, snippetChars: args.snippet_chars,
      } }, executionOptions(options, signal, onUpdate));
    },
  });
}

function registerLegacySessionSearchTool(pi: ExtensionAPI, dbManager: DatabaseManager, options: SessionSearchToolOptions): void {
  pi.registerTool({
    name: 'session_search', label: 'Session Search',
    description: `Search across past Pi coding sessions for relevant conversation context. Use this when the user asks about previous discussions, past work, or when you need context from earlier sessions.

Examples:
- "What did we discuss about auth last week?"
- "Find the PR where we fixed the test hang"
- "What approach did we take for the database migration?"

Returns bounded primary conversation snippets with session dates and project context. Tool output, service sessions, and the active chat are excluded by default; set the explicit include flags when the user asks to search the current chat or tool output. When canonical JSONL ownership is available, each result also includes session_id and entry_id for session_get. Large messages are truncated with their original character count.`,
    promptSnippet: 'Search past conversations for relevant context',
    promptGuidelines: [
      'Use session_search when the user asks about previous discussions or past work.',
      'Before acting, search when a specific fact required for the next step is absent from current context but likely exists in the evicted part of the current session or another past session.',
      'Do not guess, repeat completed work, or ask the user to restate prior context before attempting a narrow search.',
      'Ordinary search returns primary conversation only; set include_tool_output, include_service, or include_current_session explicitly for those sources.',
      'Use project, role, since, and exact session_id filters when the relevant scope is known; these filters are applied to canonical transcript facts.',
      'project refers to the conversation cwd, not a repository mentioned in its messages; omit an uncertain project filter.',
      'Search incomplete means partial:true: returned entries are canonically verified, but do not infer absence or the newest discussion across the entire archive. Open exact returned entries with session_get; narrow the query or use limit:3 for a focused follow-up.',
      'session_get accepts the separate session_id and entry_id fields from search; never pass a pi:// anchor URI as entry_id.',
      'Use session_get when exact canonical source context around a result is needed; a successful recovery requires session_search followed by session_get for the exact entry, and metadata or outline alone do not prove the requested fact.',
      'Inspect success:false and the error code in every tool result; failure is not an empty successful search.',
    ],
    renderResult: createSharedToolResultRenderer(searchResultView),
    parameters: Type.Object({
      query: Type.String({ description: 'Search query. Use natural language or specific terms.' }),
      project: Type.Optional(Type.String({ description: 'Conversation project derived from its cwd, not a repository mentioned in messages; omit when uncertain.' })),
      role: Type.Optional(StringEnum(['user', 'assistant'] as const, { description: 'Filter by message role (optional).' })),
      since: Type.Optional(Type.String({ description: 'Past YYYY-MM-DD (UTC midnight) or ISO timestamp with Z/offset, up to milliseconds (optional). Invalid and future bounds are errors.' })),
      session_id: Type.Optional(Type.String({ minLength: 1, pattern: '\\S', description: 'Non-blank exact canonical session ID (optional; do not guess a prefix). Omit this field for unrestricted session scope.' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum results to return (default: 10, min: 1, max: 20).', minimum: 1, maximum: 20 })),
      snippetChars: Type.Optional(Type.Number({ description: `Maximum characters per result snippet (default: ${DEFAULT_LEGACY_SNIPPET_CHARS}, max: ${MAX_LEGACY_SNIPPET_CHARS}; never exceed 4000).`, minimum: 100, maximum: MAX_LEGACY_SNIPPET_CHARS })),
      include_current_session: Type.Optional(Type.Boolean({ description: 'Include the active session only when explicitly requested.' })),
      include_tool_output: Type.Optional(Type.Boolean({ description: 'Include tool-call and tool-result records only when explicitly requested.' })),
      include_service: Type.Optional(Type.Boolean({ description: 'Include service and structural records only when explicitly requested.' })),
    }),
    execute: async (_id: string, args: { query: string; project?: string; role?: string; since?: string; session_id?: string; limit?: number; snippetChars?: number; include_current_session?: boolean; include_tool_output?: boolean; include_service?: boolean }, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback) => {
      if (!args.query?.trim()) return invalidRequest('query is required');
      if (args.session_id !== undefined && !args.session_id.trim()) return invalidRequest('session_id must be non-empty when provided; omit it for unrestricted session scope.', 'invalid_session_id');
      const currentSessionId = typeof options.currentSessionId === 'function' ? options.currentSessionId() : options.currentSessionId;
      return executeIndexedSearch(dbManager, { mode: 'legacy', query: args.query, snippetChars: args.snippetChars, options: {
        project: args.project, role: args.role, since: args.since, sessionId: args.session_id, limit: args.limit, sessionsDir: options.sessionsDir, currentSessionId,
        includeCurrentSession: args.include_current_session === true, includeToolOutput: args.include_tool_output === true, includeService: args.include_service === true,
      } }, executionOptions(options, signal, onUpdate));
    },
  });
}
