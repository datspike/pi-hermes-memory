import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryStore } from '../../src/store/memory-store.js';
import { buildPromptContext } from '../../src/prompt-context.js';
import { registerPreviewContextCommand } from '../../src/handlers/preview-context.js';
import { triggerConsolidation } from '../../src/handlers/auto-consolidate.js';
import { applyReviewOperations } from '../../src/handlers/review-memory-ops.js';
import { execChildPrompt } from '../../src/handlers/pi-child-process.js';
import { ENTRY_DELIMITER } from '../../src/constants.js';
import type { MemoryConfig } from '../../src/types.js';

let root: string;
const previousLockDir = process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'forwardport-memory-safety-'));
  process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR = path.join(root, 'locks');
});
after(async () => {
  if (previousLockDir === undefined) delete process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR;
  else process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR = previousLockDir;
  // Connections close at process exit; the command runner owns deferred cleanup.
  console.log(`MEMORY_SAFETY_FIXTURE=${root}`);
});
async function fixture(name: string) {
  const store = new MemoryStore({ memoryDir: path.join(root, name), memoryMode: 'legacy-inject', memoryCharLimit: 100000, userCharLimit: 100000, failureInjectionEnabled: true, failureInjectionMaxEntries: 20 } as MemoryConfig);
  await store.loadFromDisk();
  return store;
}
async function populate(store: MemoryStore) {
  for (const [text, project] of [['A_ONLY', 'project-a'], ['B_ONLY', 'project-b'], ['GLOBAL_ONLY', undefined]] as const) {
    assert.equal((await store.addFailure(text, { category: 'correction', project })).success, true);
  }
}

describe('forwardport durable memory safety', { concurrency: 1 }, () => {
  it('injects only global and the active project failures', async () => {
    const store = await fixture('inject'); await populate(store);
    const result = await buildPromptContext({ memoryMode: 'legacy-inject' }, store, null, 'project-b');
    assert.match(result, /GLOBAL_ONLY/); assert.match(result, /B_ONLY/); assert.doesNotMatch(result, /A_ONLY/);
    const global = await buildPromptContext({ memoryMode: 'legacy-inject' }, store, null, '');
    assert.match(global, /GLOBAL_ONLY/); assert.doesNotMatch(global, /A_ONLY|B_ONLY/);
  });
  it('uses the same failure boundary in the preview command', async () => {
    const store = await fixture('preview'); await populate(store);
    let command: any; let result = '';
    registerPreviewContextCommand({ registerCommand: (_name: string, definition: any) => { command = definition; } } as any, store, null, 'project-b', { memoryMode: 'legacy-inject' });
    await command.handler('', { ui: { notify: (text: string) => { result = text; } } });
    assert.match(result, /GLOBAL_ONLY/); assert.match(result, /B_ONLY/); assert.doesNotMatch(result, /A_ONLY/);
  });
  it('preserves an editor write during recovery snapshot reuse for every target', async () => {
    for (const target of ['memory', 'user', 'failure'] as const) {
      const store = await fixture(`reuse-${target}`);
      assert.equal((await store.add(target, 'initial')).success, true);
      assert.equal((await store.add(target, 'local-1')).success, true);
      const original = (store as any).shouldReuseRecoverySnapshot.bind(store);
      let injected = false;
      (store as any).shouldReuseRecoverySnapshot = async (file: string) => {
        const reuse = await original(file);
        if (reuse && !injected) { injected = true; await fs.appendFile(file, ENTRY_DELIMITER+'external-editor'); }
        return reuse;
      };
      const result = await store.add(target, 'local-2'); assert.equal(injected, true);
      const disk = await fs.readFile(await store.getStorageIdentity(target), 'utf8');
      assert.match(disk, /external-editor/, `${target} must not lose the external edit`);
      if (result.success) assert.match(disk, /local-2/);
    }
  });
  it('consolidates failures with parent-owned exact scope and no writable child tools', async () => {
    const store = await fixture('consolidate'); await populate(store);
    const originalA = store.getRawEntriesForSync('failure').find(e => e.includes('A_ONLY'))!;
    const calls: string[][] = [];
    const pi = { exec: async (_command: string, args: string[]) => {
      calls.push(args); const prompt = readFileSync(args.at(-1)!.slice(1), 'utf8');
      assert.equal(prompt.includes('A_ONLY'), false);
      assert.ok(args.includes('--no-tools')); assert.ok(!args.includes(path.resolve('src/index.ts')));
      const old = prompt.includes('B_ONLY') ? '[correction] B_ONLY' : '[correction] GLOBAL_ONLY';
      // The model cannot set its scope, and cannot remove the other project's row.
      return { code: 0, stdout: JSON.stringify({ operations: [{ action: 'replace', target: 'failure', old_text: old, content: '[correction] M' }] }), stderr: '' };
    } } as any;
    const result = await triggerConsolidation(pi, store, 'failure', undefined, 60000, 'failure', { reviewTransport: 'subprocess' }, null, null, 'project-b');
    assert.equal(result.consolidated, true); assert.equal(calls.length, 2);
    const raw = store.getRawEntriesForSync('failure'); assert.ok(raw.includes(originalA));
    const merged = raw.filter(e => e.startsWith('[correction] M ')); assert.equal(merged.length, 2);
    assert.equal(merged.filter(e => e.includes('project64=')).length, 1);
  });
});

describe('failure consolidation operation boundaries', { concurrency: 1 }, () => {
  it('keeps identical global/project lessons distinct when replacing through remove/add plans', async () => {
    const store = await fixture('identical');
    for (const project of [undefined, 'project-a', 'project-b']) await store.addFailure('IDENTICAL_LONG_LESSON', { category: 'correction', project });
    const originalA = store.getRawEntriesForSync('failure').find(e => e.includes('project64=cHJvamVjdC1h'))!;
    const pi = { exec: async () => ({ code: 0, stdout: JSON.stringify({ operations: [
      { action: 'remove', target: 'failure', old_text: 'IDENTICAL_LONG_LESSON' },
      { action: 'add', target: 'failure', content: 'M', category: 'correction', project: 'project-a' },
    ] }) }) } as any;
    const result = await triggerConsolidation(pi, store, 'failure', undefined, 60000, 'failure', { reviewTransport: 'subprocess' }, null, null, 'project-b');
    assert.equal(result.consolidated, true);
    const rows = store.getRawEntriesForSync('failure'); assert.ok(rows.includes(originalA));
    assert.equal(rows.filter(e => e.startsWith('[correction] M ')).length, 2);
    assert.equal(rows.filter(e => e.includes('project64=cHJvamVjdC1i')).length, 1);
  });
  it('reports partial progress without changing another project when a later plan escapes its scope', async () => {
    const store = await fixture('invalid-plan'); await populate(store);
    const original = store.getRawEntriesForSync('failure');
    const pi = { exec: async (_command: string, args: string[]) => {
      const prompt = readFileSync(args.at(-1)!.slice(1), 'utf8');
      const old = prompt.includes('B_ONLY') ? 'A_ONLY' : 'GLOBAL_ONLY';
      return { code: 0, stdout: JSON.stringify({ operations: [{ action: 'replace', target: 'failure', old_text: old, content: '[correction] M' }] }) };
    } } as any;
    const result = await triggerConsolidation(pi, store, 'failure', undefined, 60000, 'failure', {}, null, null, 'project-b');
    assert.equal(result.consolidated, true); assert.equal(result.partial, true);
    for (const old of original.filter(e => e.includes('A_ONLY') || e.includes('B_ONLY'))) assert.ok(store.getRawEntriesForSync('failure').includes(old));
  });
  it('binds direct plans to exact scope and preserves incremental over-capacity shrink', async () => {
    const store = await fixture('direct-plan'); await populate(store);
    await store.addFailure('UNCHANGED_TAIL_' + 'x'.repeat(600), { category: 'correction', project: 'project-b' });
    (store as any).config.memoryCharLimit = 1;
    const pi = { exec: async () => { throw new Error('No subprocess expected'); } } as any;
    const scopes: Array<string | null> = [];
    const runDirect = async (_ctx: any, target: MemoryStore, _projectStore: any, options: any, db: any, project: string | null) => {
      scopes.push(options.failureProject); assert.equal(options.failureProject, project);
      assert.equal(options.failureEntries.length, project === null ? 1 : 2, 'chunking must not split direct transport');
      const old = project === null ? 'GLOBAL_ONLY' : 'B_ONLY';
      const applied = await applyReviewOperations(target, null, [{ action: 'replace', target: 'failure', old_text: old, content: '[correction] M' }], db, project, options);
      return { ok: !applied.error, appliedCount: applied.appliedCount };
    };
    const result = await triggerConsolidation(pi, store, 'failure', undefined, 60000, 'failure', { consolidationChunking: true, consolidationChunkChars: 500 }, {} as any, null, 'project-b', { runDirectMemoryCompletion: runDirect as any });
    assert.deepEqual(scopes, [null, 'project-b']); assert.equal(result.consolidated, true); assert.equal(result.partial, true);
    assert.ok(store.getRawEntriesForSync('failure').some(e => e.includes('A_ONLY')));
  });
  it('rejects edits outside the supplied slice even within the active project', async () => {
    const store = await fixture('slice'); await populate(store);
    await store.addFailure('HIDDEN_LONG_LESSON', { category: 'correction', project: 'project-b' });
    const original = store.getRawEntriesForSync('failure');
    const result = await applyReviewOperations(store, null, [{ action: 'remove', target: 'failure', old_text: 'HIDDEN_LONG_LESSON' }], null, 'project-b', { requireAtomicShrink: true, expectedTarget: 'failure', failureProject: 'project-b', failureEntries: ['[correction] B_ONLY'] });
    assert.equal(result.appliedCount, 0); assert.match(result.error!, /outside the supplied slice/); assert.deepEqual(store.getRawEntriesForSync('failure'), original);
  });
  it('does not acquire a lock or call a model after an already-aborted signal', async () => {
    const signal = new AbortController(); signal.abort();
    const store = { getStorageIdentity: () => { throw new Error('Unexpected lock acquisition'); } } as any;
    const pi = { exec: () => { throw new Error('Unexpected model'); } } as any;
    const result = await triggerConsolidation(pi, store, 'failure', signal.signal);
    assert.equal(result.consolidated, false); assert.match(result.error!, /aborted/);
  });
  it('does not reinterpret malformed project metadata as a global lesson', async () => {
    const store = await fixture('malformed'); const today = new Date().toISOString().slice(0, 10);
    await fs.writeFile(await store.getStorageIdentity('failure'), `BAD_ONLY <!-- created=${today}, last=${today}, project64=@@ -->`);
    await store.loadFromDisk();
    assert.doesNotMatch(store.formatForSystemPrompt(), /BAD_ONLY/);
    assert.deepEqual(store.getFailureConsolidationGroups(), []);
    assert.match(store.getRawEntriesForSync('failure')[0], /BAD_ONLY/);
  });
});

describe('failure proposal subprocess', () => {
  it('retains auth sources but not Hermes/tools when retrying without model overrides', async () => {
    const calls: string[][] = [];
    const pi = { exec: async (_command: string, args: string[]) => {
      calls.push(args);
      assert.ok(args.includes('--no-tools')); assert.ok(args.includes('--no-extensions'));
      assert.ok(args.includes('./trusted-auth'));
      assert.ok(!args.includes('src/index.ts')); assert.ok(!args.includes('npm:pi-hermes-memory'));
      return calls.length === 1 ? { code: 1, stderr: 'model unknown' } : { code: 0, stdout: '{"operations":[]}' };
    } } as any;
    const result = await execChildPrompt(pi, 'Only proposals', { llmModelOverride: 'missing-model', childExtensionPaths: ['src/index.ts', 'npm:pi-hermes-memory', './trusted-auth'] }, { timeoutMs: 10000, proposalOnly: true, retryWithoutOverrides: true });
    assert.equal(result.code, 0); assert.equal(calls.length, 2);
    assert.ok(calls[0].includes('missing-model')); assert.ok(!calls[1].includes('missing-model'));
  });
});
