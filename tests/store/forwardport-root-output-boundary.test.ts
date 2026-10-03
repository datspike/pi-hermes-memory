import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { Value } from 'typebox/value';
import { DatabaseManager } from '../../src/store/db.js';
import { MemoryStore } from '../../src/store/memory-store.js';
import { canonicalSessionOwners, indexSession, upsertSessionFileMetadata } from '../../src/store/session-indexer.js';
import { searchSessions, searchSessionEvidence } from '../../src/store/session-search.js';
import { searchSessionAnchors } from '../../src/store/session-anchor-search.js';
import { registerSessionGetTool } from '../../src/tools/session-get-tool.js';
import { registerMemoryTool } from '../../src/tools/memory-tool.js';
import { registerMemorySearchTool } from '../../src/tools/memory-search-tool.js';
import { addMemory } from '../../src/store/sqlite-memory-store.js';

const OUTPUT_BUDGET = 1024 * 1024;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-output-boundary-'));
  const sessions = path.join(root, 'sessions'); fs.mkdirSync(sessions);
  const file = path.join(sessions, 'owned.jsonl');
  const header = { type: 'session', id: 'same-session', cwd: '/fixture', timestamp: '2026-10-02T00:00:00Z' };
  const transcript = (content: string) => `${JSON.stringify(header)}\n${JSON.stringify({ type: 'message', id: 'same-entry', timestamp: header.timestamp, message: { role: 'user', content } })}\n`;
  fs.writeFileSync(file, transcript('needle inside allowed'));
  const manager = new DatabaseManager(root); manager.setQuickCheckOnOpen(false);
  indexSession(manager, { id: header.id, cwd: header.cwd, project: 'fixture', startedAt: header.timestamp, endedAt: null, messages: [{ id: 'same-entry', role: 'user', content: 'needle inside allowed', timestamp: header.timestamp }] });
  upsertSessionFileMetadata(manager, file, header.id);
  return { root, sessions, file, header, transcript, manager, cleanup: () => { assert.equal(manager.close(), true); fs.rmSync(root, { recursive: true, force: true }); } };
}

async function reader(name: string, f: ReturnType<typeof fixture>): Promise<any> {
  if (name === 'owners') return canonicalSessionOwners(f.manager.getDb(), f.header.id, f.sessions);
  if (name === 'legacy') return searchSessions(f.manager, 'needle', { sessionsDir: f.sessions });
  if (name === 'structured') return searchSessionEvidence(f.manager, 'needle', { sessionsDir: f.sessions }).results;
  if (name === 'anchors') return searchSessionAnchors('any:\n- needle', { sessionsDir: f.sessions });
  let tool: any; registerSessionGetTool({ registerTool: (definition: any) => { tool = definition; } } as any, f.manager, { sessionsDir: f.sessions });
  return tool.execute('fixture', { session_id: f.header.id, entry_id: 'same-entry' });
}

for (const name of ['owners', 'legacy', 'structured', 'get', 'anchors']) {
  it(`${name} rejects a new real sessions directory at the pinned pathname before reading replacement payload`, async () => {
    const f = fixture();
    const realpath = fs.realpathSync.native; const nativeRead = fs.readSync; const nativeReadFile = fs.readFileSync;
    let swapped = false; let replacementReads = 0;
    fs.realpathSync.native = ((candidate: fs.PathLike, ...args: any[]) => {
      const result = realpath(candidate, ...args);
      if (!swapped && result === f.sessions) {
        swapped = true; fs.renameSync(f.sessions, path.join(f.root, 'parked'));
        fs.mkdirSync(f.sessions); fs.writeFileSync(f.file, f.transcript('needle outside forbidden'));
      }
      return result;
    }) as typeof fs.realpathSync.native;
    const checkRead = (candidate: fs.PathOrFileDescriptor) => {
      try { if (realpath(typeof candidate === 'number' ? `/proc/self/fd/${candidate}` : candidate) === f.file) replacementReads++; } catch { /* Invalid descriptors are not payload reads. */ }
    };
    fs.readSync = ((fd: number, ...args: any[]) => { checkRead(fd); return nativeRead(fd, ...args); }) as typeof fs.readSync;
    fs.readFileSync = ((candidate: fs.PathOrFileDescriptor, ...args: any[]) => { checkRead(candidate); return nativeReadFile(candidate, ...args); }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try {
      let result: any;
      try { result = await reader(name, f); } catch (error) { assert.match(String(error), /canonical|root|changed/i); }
      assert.equal(swapped, true);
      assert.equal(replacementReads, 0);
      assert.doesNotMatch(JSON.stringify(result) ?? '', /outside forbidden/);
      // A failed generation check must not delete the still-valid indexed owner.
      assert.equal((f.manager.getDb().prepare('SELECT COUNT(*) AS count FROM session_files').get() as { count: number }).count, 1);
    } finally {
      fs.realpathSync.native = realpath; fs.readSync = nativeRead; fs.readFileSync = nativeReadFile; syncBuiltinESMExports(); f.cleanup();
    }
  });
}

describe('public memory retrieval boundary', () => {
  it('keeps accepted large policy-only memory intact while bounding the search envelope', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-output-boundary-'));
    const manager = new DatabaseManager(root); manager.setQuickCheckOnOpen(false);
    const tools: Record<string, any> = {};
    const pi = { registerTool: (tool: any) => { tools[tool.name] = tool; } } as any;
    const store = new MemoryStore({ memoryMode: 'policy-only', memoryCharLimit: 5000, userCharLimit: 5000, projectCharLimit: 5000, nudgeInterval: 10, reviewEnabled: false, flushOnCompact: false, flushOnShutdown: false, memoryDir: root } as any);
    try {
      await store.loadFromDisk(); registerMemoryTool(pi, store, null, manager); registerMemorySearchTool(pi, manager);
      const content = 'needle ' + 'x'.repeat(2_000_000);
      const added = await tools.memory_add.execute('add', { target: 'memory', content });
      assert.equal(added.details.success, true);
      const result = await tools.memory_search.execute('search', { query: 'needle' });
      assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= OUTPUT_BUDGET);
      assert.equal(result.details.success, true);
      assert.equal(result.details.truncated, true);
      assert.match(result.content[0].text, /content truncated|response truncated/);
      assert.equal((manager.getDb().prepare('SELECT length(content) AS chars FROM memories').get() as { chars: number }).chars, content.length);
      assert.match(fs.readFileSync(path.join(root, 'MEMORY.md'), 'utf8'), /needle/);
    } finally { assert.equal(manager.close(), true); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('accepts project=null in the actual schema and retrieves only global memories', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-null-boundary-'));
    const manager = new DatabaseManager(root); manager.setQuickCheckOnOpen(false);
    try {
      addMemory(manager, 'needle global'); addMemory(manager, 'needle project', 'memory', 'project-a');
      let tool: any; registerMemorySearchTool({ registerTool: (definition: any) => { tool = definition; } } as any, manager);
      const args = { query: 'needle', project: null };
      assert.equal(Value.Check(tool.parameters, args), true);
      const result = await tool.execute('null', args);
      assert.equal(result.details.success, true); assert.equal(result.details.count, 1);
      assert.match(result.content[0].text, /needle global/); assert.doesNotMatch(result.content[0].text, /needle project/);
    } finally { assert.equal(manager.close(), true); fs.rmSync(root, { recursive: true, force: true }); }
  });
});
