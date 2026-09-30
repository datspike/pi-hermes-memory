import * as path from 'node:path';
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { DatabaseManager } from '../store/db.js';
import { searchSessionEvidence, searchSessions, getIndexedMessageCount, SESSION_SEARCH_EVIDENCE_MAX_BYTES } from '../store/session-search.js';
import { searchSessionAnchors } from '../store/session-anchor-search.js';
import type { SessionAnchorRange, SessionAnchorSearchResult } from '../store/session-anchor-search.js';
import type { SessionSearchConfig } from '../types.js';
import { AGENT_ROOT } from '../paths.js';
import { createSharedToolResultRenderer } from './shared-output-view.js';
import { searchResultView } from './tool-result-views.js';

interface SearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
  outputChars?: number;
  outputTruncated?: boolean;
  snippetChars?: number;
  truncatedCount?: number;
  ranges?: SessionAnchorRange[];
}

interface SessionSearchToolOptions {
  sessionsDir?: string;
  currentSessionId?: string | (() => string | undefined);
}

const DEFAULT_SESSIONS_DIR = path.join(AGENT_ROOT, 'sessions');
const DEFAULT_LEGACY_SNIPPET_CHARS = 1_200;
const MAX_LEGACY_SNIPPET_CHARS = 4_000;
const MAX_LEGACY_OUTPUT_CHARS = 50 * 1024;

function truncateLegacySnippet(text: string, maxChars: number, originalChars = text.length): { text: string; truncated: boolean } {
  if (text.length <= maxChars && originalChars <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n... (truncated, ${originalChars} chars total — refine the query or increase snippetChars)`,
    truncated: true,
  };
}

function capLegacyOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_LEGACY_OUTPUT_CHARS) return { text, truncated: false };
  const suffix = `\n... (output truncated, ${text.length} chars total — refine the query or lower the result limit)`;
  return {
    text: `${text.slice(0, MAX_LEGACY_OUTPUT_CHARS - suffix.length)}${suffix}`,
    truncated: true,
  };
}

export function registerSessionSearchTool(
  pi: ExtensionAPI,
  dbManager: DatabaseManager,
  sessionSearchConfig: SessionSearchConfig = { variant: 'legacy' },
  options: SessionSearchToolOptions = {},
): void {
  if (sessionSearchConfig.variant === 'anchors') {
    registerAnchorSessionSearchTool(pi, options.sessionsDir ?? DEFAULT_SESSIONS_DIR);
    return;
  }
  if (sessionSearchConfig.variant === 'structured') {
    registerStructuredSessionSearchTool(pi, dbManager, options);
    return;
  }

  registerLegacySessionSearchTool(pi, dbManager, options.sessionsDir);
}

function registerAnchorSessionSearchTool(pi: ExtensionAPI, sessionsDir: string): void {
  pi.registerTool({
    name: 'session_search',
    label: 'Session Search',
    description: `Search Pi session JSONL files in the opt-in anchor mode using a Markdown request.

This mode accepts only a markdown request. Supported scalar fields are from, to, cwd, and limit. Supported list sections are all, any, and exclude: all terms must match, any requires at least one listed term, and exclude removes matching ranges. It returns compact JSONL line-range anchors, not summaries or previews. Output is plain text: count, optional message, then anchors as path:startLine-endLine with a short reason.

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
      'Request source anchors, not summaries or previews.',
      'Use all for required terms, any for alternatives, and exclude for terms that must not appear in a returned range.',
    ],
    renderResult: createSharedToolResultRenderer(searchResultView),
    parameters: Type.Object({
      markdown: Type.String({ description: 'Markdown request with optional from/to/cwd/limit fields and all/any/exclude lists.' }),
    }),
    execute: async (_id: string, args: { markdown: string }) => {
      const markdown = args.markdown;

      if (!markdown || markdown.trim().length === 0) {
        const result: SearchResult = { success: false, message: 'markdown is required' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const searchResult = searchSessionAnchors(markdown, { sessionsDir });
      if (!searchResult.success) {
        const result: SearchResult = { success: false, message: searchResult.message ?? 'Anchor session search failed.' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const output = formatAnchorSearchOutput(searchResult);
      const result: SearchResult = {
        success: true,
        count: searchResult.ranges.length,
        message: searchResult.message,
        output,
        ranges: searchResult.ranges,
      };
      return { content: [{ type: 'text' as const, text: output }], details: result };
    },
  });
}

function formatAnchorSearchOutput(searchResult: SessionAnchorSearchResult): string {
  const lines = [`count: ${searchResult.ranges.length}`];
  if (searchResult.message) lines.push(`message: ${searchResult.message}`);
  if (searchResult.ranges.length > 0) {
    lines.push("anchors:");
    for (const range of searchResult.ranges) {
      const anchor = `${range.path}:${range.startLine}-${range.endLine}`;
      const reason = compactReason(range.reason);
      lines.push(reason ? `- ${anchor} — ${reason}` : `- ${anchor}`);
    }
  }
  return lines.join("\n");
}

function compactReason(reason: string | undefined): string {
  if (!reason) return "";
  const oneLine = reason.replace(/\s+/g, " ").trim();
  return oneLine.length <= 180 ? oneLine : `${oneLine.slice(0, 177)}...`;
}

function registerStructuredSessionSearchTool(pi: ExtensionAPI, dbManager: DatabaseManager, options: SessionSearchToolOptions): void {
  pi.registerTool({
    name: 'session_search',
    label: 'Session Search',
    description: 'Search canonical Pi session JSONL evidence. Results contain stable session_id and entry_id anchors that can be opened later with session_get. Current-session, service, and tool-output rows are opt-in.',
    promptSnippet: 'Search past sessions for canonical structured evidence',
    promptGuidelines: [
      'Use this mode when exact session evidence and an entry anchor are needed.',
      'Pass includeCurrentSession, includeService, or includeToolOutput explicitly when those rows are required.',
      'Use session_id for an exact ID or a bounded, unambiguous prefix; do not guess among ambiguous prefixes.',
    ],
    renderResult: createSharedToolResultRenderer(searchResultView),
    parameters: Type.Object({
      query: Type.String({ description: 'Search terms.' }),
      session_id: Type.Optional(Type.String({ description: 'Exact session ID or an unambiguous prefix.' })),
      project: Type.Optional(Type.String({ description: 'Filter by project.' })),
      role: Type.Optional(StringEnum(['user', 'assistant', 'system'] as const)),
      since: Type.Optional(Type.String({ description: 'ISO timestamp lower bound.' })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
      include_current_session: Type.Optional(Type.Boolean()),
      include_service: Type.Optional(Type.Boolean()),
      include_tool_output: Type.Optional(Type.Boolean()),
      snippet_chars: Type.Optional(Type.Number({ minimum: 80, maximum: 4000 })),
    }),
    execute: async (_id: string, args: { query: string; session_id?: string; project?: string; role?: string; since?: string; limit?: number; include_current_session?: boolean; include_service?: boolean; include_tool_output?: boolean; snippet_chars?: number }) => {
      if (!args.query?.trim()) {
        const result: SearchResult = { success: false, message: 'query is required' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }
      const currentSessionId = typeof options.currentSessionId === 'function' ? options.currentSessionId() : options.currentSessionId;
      let outcome: ReturnType<typeof searchSessionEvidence>;
      try {
        outcome = searchSessionEvidence(dbManager, args.query, {
          sessionId: args.session_id, project: args.project, role: args.role, since: args.since, limit: args.limit, sessionsDir: options.sessionsDir,
          currentSessionId, includeCurrentSession: args.include_current_session === true, includeService: args.include_service === true,
          includeToolOutput: args.include_tool_output === true, snippetChars: args.snippet_chars,
        });
      } catch (error) {
        if (error instanceof Error && (error.name === 'SessionEvidenceUnavailableError' || (error as Error & { code?: string }).code === 'SESSION_EVIDENCE_UNAVAILABLE' || /migration pending|evidence unavailable/i.test(error.message))) {
          const result = { success: false, error: 'session_evidence_unavailable' };
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result };
        }
        throw error;
      }
      if (outcome.ambiguousSessionIds.length > 0) {
        const candidates: string[] = [];
        for (const candidate of outcome.ambiguousSessionIds) {
          const next = [...candidates, candidate];
          const candidateText = JSON.stringify({ error: 'ambiguous_session_id', count: next.length, candidates: next });
          if (Buffer.byteLength(candidateText, 'utf8') > SESSION_SEARCH_EVIDENCE_MAX_BYTES) break;
          candidates.push(candidate);
        }
        const message = JSON.stringify({ error: 'ambiguous_session_id', count: candidates.length, candidates });
        return { content: [{ type: 'text' as const, text: message }], details: { success: false, count: candidates.length, candidates } };
      }
      const lines = outcome.results.map((e) => JSON.stringify({
        session_id: e.sessionId, entry_id: e.entryId, project: e.project, cwd: e.cwd, name: e.name,
        role: e.role, kind: e.kind, tool: e.tool, tool_call_id: e.tool_call_id, timestamp: e.timestamp, snippet: e.snippet,
        score: e.score, score_mode: e.scoreMode, anchor: e.anchor,
      }));
      let output = '';
      let count = 0;
      for (const line of lines) {
        const candidate = output ? `${output}\n${line}` : line;
        if (Buffer.byteLength(candidate, 'utf8') > SESSION_SEARCH_EVIDENCE_MAX_BYTES) break;
        output = candidate;
        count += 1;
      }
      const details = {
        success: true,
        count,
        outputBytes: Buffer.byteLength(output, 'utf8'),
        outputTruncated: count < lines.length,
        sessionIds: [...new Set(outcome.results.slice(0, count).map((entry) => entry.sessionId))],
      };
      return { content: [{ type: 'text' as const, text: output || 'No results found.' }], details };
    },
  });
}

function registerLegacySessionSearchTool(pi: ExtensionAPI, dbManager: DatabaseManager, sessionsDir?: string): void {
  pi.registerTool({
    name: 'session_search',
    label: 'Session Search',
    description: `Search across past Pi coding sessions for relevant conversation context. Use this when the user asks about previous discussions, past work, or when you need context from earlier sessions.

Examples:
- "What did we discuss about auth last week?"
- "Find the PR where we fixed the test hang"
- "What approach did we take for the database migration?"

Returns bounded conversation snippets with session dates and project context. Large messages are truncated with their original character count.`,
    promptSnippet: 'Search past conversations for relevant context',
    promptGuidelines: [
      'Use session_search when the user asks about previous discussions or past work.',
      'Use session_search when you need context from earlier sessions.',
    ],
    renderResult: createSharedToolResultRenderer(searchResultView),
    parameters: Type.Object({
      query: Type.String({ description: 'Search query. Use natural language or specific terms.' }),
      project: Type.Optional(Type.String({ description: 'Filter by project name (optional).' })),
      role: Type.Optional(StringEnum(['user', 'assistant'] as const, { description: 'Filter by message role (optional).' })),
      limit: Type.Optional(Type.Number({
        description: 'Maximum results to return (default: 10, min: 1, max: 20).',
        minimum: 1,
        maximum: 20,
      })),
      snippetChars: Type.Optional(Type.Number({
        description: `Maximum characters per result snippet (default: ${DEFAULT_LEGACY_SNIPPET_CHARS}, max: ${MAX_LEGACY_SNIPPET_CHARS}).`,
        minimum: 100,
        maximum: MAX_LEGACY_SNIPPET_CHARS,
      })),
    }),
    execute: async (_id: string, args: { query: string; project?: string; role?: string; limit?: number; snippetChars?: number }) => {
      const query = args.query;
      const project = args.project;
      const role = args.role;
      const requestedLimit = Number.isFinite(args.limit) ? Math.floor(args.limit!) : 10;
      const limit = Math.min(Math.max(requestedLimit, 1), 20);
      const requestedSnippetChars = Number.isFinite(args.snippetChars)
        ? Math.floor(args.snippetChars!)
        : DEFAULT_LEGACY_SNIPPET_CHARS;
      const snippetChars = Math.min(Math.max(requestedSnippetChars, 100), MAX_LEGACY_SNIPPET_CHARS);

      if (!query || query.trim().length === 0) {
        const result: SearchResult = { success: false, message: 'query is required' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      try {
        dbManager.assertSessionEvidenceAvailable();
      } catch (error) {
        if (error instanceof Error && (error.name === 'SessionEvidenceUnavailableError' || (error as Error & { code?: string }).code === 'SESSION_EVIDENCE_UNAVAILABLE' || /migration pending|evidence unavailable/i.test(error.message))) {
          const result = { success: false, error: 'session_evidence_unavailable' } as const;
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result };
        }
        throw error;
      }

      const totalMessages = getIndexedMessageCount(dbManager);
      if (totalMessages === 0) {
        const result: SearchResult = { success: false, message: 'No sessions indexed yet. Run /memory-index-sessions to import past sessions.' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const results = searchSessions(dbManager, query, { project, role, limit, sessionsDir });

      if (results.length === 0) {
        const output = capLegacyOutput('No results found. Try a different search term or broader query.');
        const result: SearchResult = {
          success: true,
          count: 0,
          message: output.text,
          outputChars: output.text.length,
          outputTruncated: output.truncated,
        };
        return { content: [{ type: 'text' as const, text: output.text }], details: result };
      }

      const blocks: string[] = [`Found ${results.length} results for "${query}":`];
      let truncatedCount = 0;

      for (const r of results) {
        const date = new Date(r.timestamp).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        });

        const snippet = truncateLegacySnippet(r.snippet, snippetChars, r.contentChars);
        if (snippet.truncated) truncatedCount += 1;
        blocks.push([
          '---',
          `📅 ${date} | 📁 ${r.project} | ${r.role === 'user' ? '👤 User' : '🤖 Assistant'}`,
          snippet.text,
        ].join('\n'));
      }

      const output = capLegacyOutput(blocks.join('\n\n').trim());
      const finalResult: SearchResult = {
        success: true,
        count: results.length,
        truncatedCount,
        snippetChars,
        outputChars: output.text.length,
        outputTruncated: output.truncated,
      };
      return { content: [{ type: 'text' as const, text: output.text }], details: finalResult };
    },
  });
}
