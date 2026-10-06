import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSessionSearchTool } from '../../src/tools/session-search-tool.js';
import { searchSessions, searchSessionEvidence } from '../../src/store/session-search.js';

const invalid = ['', ' ', 'not-a-date', '2026-02-30', '2025-02-29T00:00:00Z', '2026-01-01T12:00:00', '2026-01-01T25:00:00Z'];
const future = new Date(Date.now() + 86_400_000).toISOString();
const noDb = {
  getPath() { assert.fail('date validation requested the database path'); },
  getDb() { assert.fail('date validation opened the database'); },
  assertSessionEvidenceAvailable() { assert.fail('date validation inspected evidence'); },
};

for (const variant of ['legacy', 'structured'] as const) {
  test(`${variant} rejects malformed and future since before launching a worker`, async () => {
    let tool: any;
    registerSessionSearchTool({ registerTool(definition: any) { tool = definition; } } as any, noDb as any, { variant });
    for (const since of [...invalid, future]) {
      const result = await tool.execute('invalid-since', { query:'transcribe', project:'obsidian-vault', since });
      assert.equal(result.isError, true); assert.equal(result.details.success, false);
      assert.equal(result.details.error, since === future ? 'since_in_future' : 'invalid_since');
      assert.match(result.content[0].text, /since/i);
    }
  });
}

for (const search of [searchSessions, searchSessionEvidence]) {
  test(`${search.name} rejects malformed/future since before any database access`, () => {
    for (const since of [...invalid, future]) {
      assert.throws(() => search(noDb as any, 'transcribe', { since }), (error: any) => error.code === (since === future ? 'SINCE_IN_FUTURE' : 'INVALID_SINCE'));
    }
  });
}

test('since normalizes dates, leap days, fractions and timezone offsets by instant', async () => {
  const { normalizeSessionSearchSince: normalize } = await import('../../src/store/session-search-since.js');
  const now = Date.parse('2026-10-01T00:00:00Z');
  for (const [input, expected] of [
    ['2026-09-25', '2026-09-25T00:00:00.000Z'],
    ['2024-02-29T00:00:00Z', '2024-02-29T00:00:00.000Z'],
    ['2026-09-25T01:00:00+01:00', '2026-09-25T00:00:00.000Z'],
    ['2026-09-24T23:00:00-01:00', '2026-09-25T00:00:00.000Z'],
    ['2026-09-25T00:00:00.1Z', '2026-09-25T00:00:00.100Z'],
    ['2026-10-01T02:00:00+02:00', '2026-10-01T00:00:00.000Z'],
  ]) assert.equal(normalize(input, now), expected);
  assert.equal(normalize(undefined, now), undefined);
  assert.throws(() => normalize('2026-10-01T00:00:00.001Z', now), (error: any) => error.code === 'SINCE_IN_FUTURE');
  for (const input of ['2026-13-01','2026-00-01','2026-01-00','2026-01-01T00:00:00+24:00','2026-01-01T00:00:00+01:60','2026-01-01T00:00:00.0000Z','0000-01-01T00:00:00+01:00']) {
    assert.throws(() => normalize(input, now), (error: any) => error.code === 'INVALID_SINCE');
  }
});

test('both public variants keep canonical historical hits for equivalent UTC/date/offset bounds', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { DatabaseManager } = await import('../../src/store/db.js');
  const { indexAllSessions } = await import('../../src/store/session-indexer.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-since-'));
  const root = path.join(dir, 'sessions'); fs.mkdirSync(root);
  const file = path.join(root, 'since-session.jsonl');
  fs.writeFileSync(file, [
    {type:'session',id:'since-session',cwd:'/work/vault',timestamp:'2025-01-01T00:00:00Z'},
    ...[
      ['before','2025-09-24T23:59:59.999Z'],
      ['offset-before','2025-09-25T00:59:59+01:00'],
      ['at','2025-09-25T00:00:00.000Z'],
      ['after','2025-09-25T00:00:00.001Z'],
    ].map(([id,timestamp]) => ({type:'message',id,timestamp,message:{role:'user',content:'since needle'}})),
  ].map(entry => JSON.stringify(entry)).join('\n')+'\n');
  const manager = new DatabaseManager(dir);
  try {
    await indexAllSessions(manager,root);
    const indexed = searchSessions(manager, 'needle', { since:'2025-09-25T01:00:00+01:00' });
    assert.equal(indexed.length, 2, 'indexed-only date comparison respects offsets');
    for (const variant of ['legacy','structured'] as const) {
      let tool: any;
      registerSessionSearchTool({registerTool(definition: any){tool=definition;}} as any,manager,{variant},{sessionsDir:root});
      for (const since of ['2025-09-25','2025-09-25T01:00:00+01:00','2025-09-24T23:00:00-01:00']) {
        const result = await tool.execute('historical-since',{query:'needle',role:'user',since});
        assert.equal(result.details.success,true); assert.equal(result.details.count,2);
        const text = result.content[0].text;
        assert.ok(text.includes(variant === 'legacy' ? 'entry_id=at' : '"entry_id":"at"'));
        assert.ok(text.includes(variant === 'legacy' ? 'entry_id=after' : '"entry_id":"after"'));
        assert.ok(!text.includes(variant === 'legacy' ? 'entry_id=before' : '"entry_id":"before"'));
      }
    }
  } finally {manager.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('registered legacy/structured schemas describe the accepted since and failure contract', () => {
  for (const variant of ['legacy','structured'] as const) {
    let tool: any;
    registerSessionSearchTool({registerTool(definition: any){tool=definition;}} as any,noDb as any,{variant});
    const description = tool.parameters.properties.since.description;
    assert.match(description,/YYYY-MM-DD/); assert.match(description,/UTC midnight/);
    assert.match(description,/Z\/offset/); assert.match(description,/milliseconds/);
    assert.match(description,/Invalid and future bounds are errors/);
  }
});
