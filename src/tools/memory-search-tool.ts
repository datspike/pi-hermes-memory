import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { DatabaseManager } from '../store/db.js';
import { searchMemories, getMemoryStats } from '../store/sqlite-memory-store.js';
import type { MemoryCategory } from '../types.js';
import { createSharedToolResultRenderer } from './shared-output-view.js';
import { searchResultView } from './tool-result-views.js';

const MAX_MEMORY_SEARCH_RESPONSE_BYTES = 1024 * 1024;
const MAX_MEMORY_ENTRY_OUTPUT_BYTES = 64 * 1024;
const MAX_DISPLAY_QUERY_BYTES = 4 * 1024;

interface SearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
  truncated?: boolean;
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

function responseFits(output: string, count: number, truncated: boolean): boolean {
  const details: SearchResult = { success: true, count, output, ...(truncated ? { truncated: true } : {}) };
  return Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: output }], details }), 'utf8') <= MAX_MEMORY_SEARCH_RESPONSE_BYTES;
}

function mutationTarget(entry: { target: "memory" | "user" | "failure"; project: string | null }): "memory" | "user" | "failure" | "project" {
  // A project name scopes ordinary memory entries, but project-attributed
  // failures still live in (and must be mutated through) the failure store.
  return entry.target === "memory" && entry.project ? "project" : entry.target;
}

function scopeLabel(project: string | null): string {
  return project ? `project:${encodeURIComponent(project)}` : "global";
}

export function registerMemorySearchTool(pi: ExtensionAPI, dbManager: DatabaseManager): void {
  pi.registerTool({
    name: 'memory_search',
    label: 'Memory Search',
    description: `Search extended memory store for relevant entries. Use this when you need context beyond what's in the system prompt — the extended store has unlimited capacity and is searchable.

Use cases:
- Find memories about a specific topic: "What do I know about auth setup?"
- Search project-specific memories: "What conventions does project X follow?"
- Find user preferences: "What are the user's testing preferences?"
- Search for past failures: "memory_search('auth', category='failure')"

target="project" returns only project-attributed memory entries (the ones labeled [target=project]); combine with project to search a named project.

Returns matching memory entries with their mutation target, scope, and dates. The displayed target is the value required by memory_replace and memory_remove.`,
    promptSnippet: 'Search extended memory store (unlimited capacity)',
    promptGuidelines: [
      'Use memory_search when you need context beyond what is in the system prompt.',
      'Use memory_search to find project-specific memories or user preferences.',
      'Use memory_search with category filter to find specific types of memories (failure, correction, insight, etc.).',
    ],
    renderResult: createSharedToolResultRenderer(searchResultView),
    parameters: Type.Object({
      query: Type.String({ description: 'Search query. Use natural language or specific terms.' }),
      project: Type.Optional(Type.Union([Type.String({ description: 'Filter by project name.' }), Type.Null({ description: 'Search global memories only.' })])),
      target: Type.Optional(StringEnum(['memory', 'user', 'failure', 'project'] as const, { description: 'Filter by target type: memory, user, failure, or project-attributed memories.' })),
      category: Type.Optional(StringEnum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk'] as const, { description: 'Filter by memory category.' })),
      limit: Type.Optional(Type.Integer({ description: 'Maximum results to return (default: 10, min: 1, max: 20).', minimum: 1, maximum: 20 })),
    }),
    execute: async (_id: string, args: { query: string; project?: string | null; target?: 'memory' | 'user' | 'failure' | 'project'; category?: string; limit?: number }) => {
      const query = args.query;
      const project = args.project;
      const target = args.target;
      const category = args.category as MemoryCategory | undefined;
      const limit = Math.min(Math.max(Number.isFinite(args.limit) ? Math.floor(args.limit as number) : 10, 1), 20);

      if (!query || query.trim().length === 0) {
        const result: SearchResult = { success: false, message: 'query is required' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const stats = getMemoryStats(dbManager);
      if (stats.total === 0) {
        const result: SearchResult = { success: false, message: 'No memories in extended store yet. Use memory_add to store memories.' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const results = searchMemories(dbManager, query, { project, target, category, limit });

      if (results.length === 0) {
        const result: SearchResult = { success: true, count: 0, message: `No memories found matching "${query}". Try a different search term or broader query.` };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const displayQuery = truncateUtf8(query, MAX_DISPLAY_QUERY_BYTES);
      let output = `Found ${results.length} memories matching "${displayQuery}":\n\n`;
      let truncated = false;
      for (const entry of results) {
        const target = mutationTarget(entry);
        const projectLabel = `scope=${scopeLabel(entry.project)}`;
        const mutationTargetLabel = `[target=${target}]`;
        const targetLabel = entry.target === 'user' ? '👤' : entry.target === 'failure' ? '⚠️' : '🧠';
        const categoryLabel = entry.category ? ` [${entry.category}]` : '';
        const boundedContent = truncateUtf8(entry.content, MAX_MEMORY_ENTRY_OUTPUT_BYTES);
        const entryTruncated = boundedContent.length !== entry.content.length || Buffer.byteLength(boundedContent, 'utf8') !== Buffer.byteLength(entry.content, 'utf8');
        const marker = entryTruncated ? `\n   [content truncated; memory_id=${entry.id}]` : '';
        const block = `${targetLabel} ${projectLabel} ${mutationTargetLabel}${categoryLabel} ${boundedContent}${marker}\n   Created: ${entry.created} | Last used: ${entry.lastReferenced}\n\n`;
        const candidate = output + block;
        if (!responseFits(candidate.trim(), results.length, truncated || entryTruncated)) {
          truncated = true;
          const limitMarker = `\n[response truncated; ${results.length - results.indexOf(entry)} result(s) omitted]`;
          const marked = output + limitMarker;
          if (responseFits(marked.trim(), results.length, true)) output = marked;
          break;
        }
        output = candidate;
        truncated ||= entryTruncated;
      }
      const finalOutput = output.trim();
      const finalResult: SearchResult = { success: true, count: results.length, output: finalOutput, ...(truncated ? { truncated: true, message: 'Some memory content was truncated to keep the response within the 1 MiB output budget.' } : {}) };
      if (!responseFits(finalOutput, results.length, truncated)) {
        const safeResult: SearchResult = { success: false, message: 'memory_search_response_limit' };
        return { content: [{ type: 'text' as const, text: safeResult.message! }], details: safeResult };
      }
      return { content: [{ type: 'text' as const, text: finalOutput }], details: finalResult };
    },
  });
}
