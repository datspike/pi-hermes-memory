import { afterEach, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { addMemory, searchMemories } from '../../src/store/sqlite-memory-store.js';
import { normalizeMemoryLookupText } from '../../src/store/memory-lookup.js';
import { registerMemorySearchTool } from '../../src/tools/memory-search-tool.js';

let ROOT_DIR = '';

afterEach(() => {
  if (ROOT_DIR) fs.rmSync(ROOT_DIR, { recursive: true, force: true });
  ROOT_DIR = '';
});

function makeDbManager(): DatabaseManager {
  ROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-search-tool-test-'));
  return new DatabaseManager(ROOT_DIR);
}

describe('registerMemorySearchTool', () => {
  it('returns a broader natural-language match when strict term matching misses', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, "user's name is Naruto", 'user');

    let captured: any;
    const mockPi = {
      registerTool: (def: any) => {
        captured = def;
      },
    } as any;

    registerMemorySearchTool(mockPi, dbManager);

    const result = await captured.execute('tc-1', { query: 'name identity Naruto', target: 'user' });

    assert.strictEqual(result.details.success, true);
    assert.strictEqual(result.details.count, 1);
    assert.match(result.content[0].text, /Naruto/);

    dbManager.close();
  });

  it('labels every result with its mutation target and unambiguous scope', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, 'global deployment convention');
    addMemory(dbManager, 'user deployment preference', 'user');
    addMemory(dbManager, 'failure deployment lesson', 'failure');
    addMemory(dbManager, 'project deployment convention', 'memory', 'project-a');
    addMemory(dbManager, 'project failure deployment lesson', 'failure', 'project-a');

    let captured: any;
    registerMemorySearchTool({ registerTool: (def: any) => { captured = def; } } as any, dbManager);

    const result = await captured.execute('tc-1', { query: 'deployment' });
    const text = result.content[0].text;

    assert.match(text, /scope=global \[target=memory\] global deployment convention/);
    assert.match(text, /scope=global \[target=user\] user deployment preference/);
    assert.match(text, /scope=global \[target=failure\] failure deployment lesson/);
    assert.match(text, /scope=project:project-a \[target=project\] project deployment convention/);
    assert.match(text, /scope=project:project-a \[target=failure\] project failure deployment lesson/);

    dbManager.close();
  });

  it('accepts target "project" as a filter and shows the schema value', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, 'project deployment convention', 'memory', 'project-a');
    addMemory(dbManager, 'global deployment convention');
    addMemory(dbManager, 'project failure deployment lesson', 'failure', 'project-a');

    let captured: any;
    registerMemorySearchTool({ registerTool: (def: any) => { captured = def; } } as any, dbManager);

    assert.ok(captured.parameters.properties.target.enum.includes('project'));

    const result = await captured.execute('tc-1', { query: 'deployment', target: 'project' });
    const text = result.content[0].text;

    assert.strictEqual(result.details.success, true);
    assert.strictEqual(result.details.count, 1);
    assert.match(text, /scope=project:project-a \[target=project\]/);
    assert.doesNotMatch(text, /scope=global/);

    dbManager.close();
  });

  it('keeps project and target scopes in the all-stop-word literal fallback', async () => {
    const dbManager = makeDbManager();
    try {
      addMemory(dbManager, 'the project-a rule', 'memory', 'project-a');
      addMemory(dbManager, 'the project-b rule', 'memory', 'project-b');
      addMemory(dbManager, 'the global rule');
      addMemory(dbManager, 'the failure rule', 'failure', 'project-a');
      let captured: any;
      registerMemorySearchTool({ registerTool: (def: any) => { captured = def; } } as any, dbManager);
      for (const query of ['the', 'the and']) {
        const project = await captured.execute('all-stop', { query, target: 'project' });
        assert.equal(project.details.count, 2);
        assert.doesNotMatch(project.content[0].text, /scope=global|target=failure/);
        const one = await captured.execute('one-project', { query, target: 'project', project: 'project-a' });
        assert.equal(one.details.count, 1);
        assert.equal(searchMemories(dbManager, query, { target: 'project', project: null }).length, 0);
        assert.equal(searchMemories(dbManager, query, { target: 'failure', project: 'project-a' }).length, 1);
        assert.equal(searchMemories(dbManager, query, { target: 'project', limit: -1 }).length, 1);
      }
    } finally { dbManager.close(); }
  });
  it('keeps copied results reversible when a project name contains brackets', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, 'literal project entry', 'memory', 'foo] bar');

    let captured: any;
    registerMemorySearchTool({ registerTool: (def: any) => { captured = def; } } as any, dbManager);

    const result = await captured.execute('tc-1', { query: 'literal' });
    const firstResultLine = result.content[0].text.split('\n').find((line: string) => line.startsWith('🧠'))!;

    assert.match(firstResultLine, /scope=project:foo%5D%20bar \[target=project\]/);
    assert.equal(normalizeMemoryLookupText(firstResultLine), 'literal project entry');

    dbManager.close();
  });

  it('bounds malformed runtime limits for both FTS and short-CJK lookup', async () => {
    const dbManager = makeDbManager();
    try {
      for (let index = 0; index < 25; index++) addMemory(dbManager, `needle 设备 record ${index}`);
      let captured: any;
      registerMemorySearchTool({ registerTool: (def: any) => { captured = def; } } as any, dbManager);
      const cases = [
        [-1, 1], [0, 1], [0.5, 1], [1.9, 1], [21, 20],
        [NaN, 10], [Infinity, 10], [-Infinity, 10], [undefined, 10],
      ] as const;
      for (const query of ['needle', '设备']) {
        for (const [limit, expected] of cases) {
          const result = await captured.execute('limit', { query, limit });
          assert.equal(result.details.success, true);
          assert.equal(result.details.count, expected, `${query}: limit ${limit}`);
        }
      }
    } finally { dbManager.close(); }
  });

  it('declares a finite integer limit between one and twenty', () => {
    const dbManager = makeDbManager();
    try {
      let captured: any;
      registerMemorySearchTool({ registerTool: (def: any) => { captured = def; } } as any, dbManager);
      const limit = captured.parameters.properties.limit;
      assert.equal(limit.type, 'integer');
      assert.equal(limit.minimum, 1);
      assert.equal(limit.maximum, 20);
    } finally { dbManager.close(); }
  });

  it('keeps direct store limits finite without imposing the tool maximum on valid callers', () => {
    const dbManager = makeDbManager();
    try {
      for (let index = 0; index < 30; index++) addMemory(dbManager, `needle 设备 record ${index}`);
      for (const query of ['needle', '设备']) {
        assert.equal(searchMemories(dbManager, query, { limit: -1 }).length, 1);
        assert.equal(searchMemories(dbManager, query, { limit: 0.5 }).length, 1);
        assert.equal(searchMemories(dbManager, query, { limit: Infinity }).length, 10);
        assert.equal(searchMemories(dbManager, query, { limit: NaN }).length, 10);
        assert.equal(searchMemories(dbManager, query, { limit: 25 }).length, 25);
      }
    } finally { dbManager.close(); }
  });
});
