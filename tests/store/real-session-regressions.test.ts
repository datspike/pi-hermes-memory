import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { DatabaseManager } from '../../src/store/db.ts';
import { indexLiveSession, indexSession, upsertSessionFileMetadata } from '../../src/store/session-indexer.ts';
import { parseSessionFile, parseSessionFileForSearch, SESSION_SEARCH_MAX_SCAN_BYTES } from '../../src/store/session-parser.ts';
import { searchSessions, searchSessionEvidence } from '../../src/store/session-search.ts';
import { registerSessionGetTool } from '../../src/tools/session-get-tool.ts';
import { formatLegacySearch, formatStructuredSearch } from '../../src/store/session-search-output.ts';
import { runSessionSearch } from '../../src/store/session-search-async.ts';
import { searchResultView } from '../../src/tools/tool-result-views.ts';

const timestamp = '2026-10-06T04:51:33.000Z';
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-real-session-'));
  const root = path.join(dir, 'sessions'); fs.mkdirSync(root);
  const db = new DatabaseManager(path.join(dir, 'db'));
  return { dir, root, db, close() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
function write(root: string, id: string, entries: any[], cwd = '/projects/vault') {
  const header = { type: 'session', version: 3, id, timestamp, cwd };
  const file = path.join(root, `2026-10-06_${id}.jsonl`);
  fs.writeFileSync(file, [header, ...entries].map(e => JSON.stringify(e)).join('\n') + '\n');
  return { file, header };
}
function message(id: string, text: string, role = 'user') {
  return { type: 'message', id, parentId: null, timestamp, message: { role, content: [{ type: 'text', text }] } };
}
async function get(db: DatabaseManager, root: string, id: string, entry: string) {
  let tool: any;
  registerSessionGetTool({ registerTool(value: any) { tool = value; } } as any, db, { sessionsDir: root });
  return tool.execute('test', { session_id: id, entry_id: entry, before: 0, after: 0 });
}

test('ordinary live indexing makes a fresh persisted session searchable before shutdown', async () => {
  const f = fixture();
  try {
    const entry = message('fresh-user', 'transcribe latest live work');
    const { file, header } = write(f.root, 'fresh', [entry]);
    indexLiveSession(f.db, { getSessionFile: () => file, getHeader: () => header, getEntries: () => [entry] }, f.root);
    assert.equal((f.db.getDb().prepare('SELECT count(*) AS n FROM session_files WHERE session_id=?').get('fresh') as any).n, 1);
    for (const search of [searchSessions, searchSessionEvidence]) {
      const result: any = search(f.db, 'transcribe', { sessionsDir: f.root, sessionId: 'fresh', includeCurrentSession: true });
      const hits = Array.isArray(result) ? result : result.results;
      assert.equal(hits[0]?.entryId, 'fresh-user');
    }
    assert.equal(JSON.parse((await get(f.db, f.root, 'fresh', 'fresh-user')).content[0].text).entry.content, 'transcribe latest live work');
  } finally { f.close(); }
});

test('unregistered exact get does not spend the payload budget on an unrelated large transcript', async () => {
  const f = fixture();
  try {
    const foreign = write(f.root, 'a-foreign', [message('foreign', 'other work')]);
    fs.truncateSync(foreign.file, SESSION_SEARCH_MAX_SCAN_BYTES + 1);
    write(f.root, 'z-target', [message('target', 'wanted exact content')]);
    const output = await get(f.db, f.root, 'z-target', 'target');
    assert.equal(output.isError, undefined);
    assert.equal(JSON.parse(output.content[0].text).entry.content, 'wanted exact content');
  } finally { f.close(); }
});

test('canonical candidates from one transcript are read once across candidate pages', () => {
  const f = fixture();
  try {
    const rows = Array.from({ length: 150 }, (_, i) => message(`tool-${i}`, 'transcribe irrelevant tool text', 'system'));
    rows.push(message('wanted-user', 'transcribe actual user request'));
    const { file } = write(f.root, 'paged', rows);
    indexSession(f.db, parseSessionFile(file)!); upsertSessionFileMetadata(f.db, file, 'paged');
    f.db.getDb().prepare("UPDATE messages SET role='system' WHERE entry_id='wanted-user'").run();
    const original = fs.readSync;
    let reads = 0;
    fs.readSync = ((...args: any[]) => { const n = (original as any)(...args); if (n) reads++; return n; }) as any;
    try {
      const hits = searchSessions(f.db, 'transcribe', { sessionsDir: f.root, role: 'user', limit: 1 });
      assert.equal(hits[0]?.entryId, 'wanted-user');
      assert.ok(reads <= 2, `Transcript reread ${reads} times`);
    } finally { fs.readSync = original; }
  } finally { f.close(); }
});

test('full and streaming readers use the first Pi header, not a later injected header', () => {
  const f = fixture();
  try {
    const { file } = write(f.root, 'leading', [
      { type: 'session', id: 'later', cwd: '/projects/other', timestamp },
      message('wanted', 'source from the leading session'),
      { type: 'session_info', name: 'latest name' },
    ]);
    const full = parseSessionFile(file)!;
    assert.equal(full.id, 'leading'); assert.equal(full.project, 'vault'); assert.equal(full.name, 'latest name');
    const streamed = parseSessionFileForSearch(file, { sessionId: 'leading', entryIds: new Set(['wanted']), project: 'vault', budget: { remainingBytes: 100_000 } })!;
    assert.equal(streamed.id, 'leading'); assert.equal(streamed.entries![0].entryId, 'wanted'); assert.equal(streamed.name, 'latest name');
    fs.writeFileSync(file, [{ type: 'session', id: null, cwd: '/projects/invalid', timestamp }, { type: 'session', id: 'leading', cwd: '/projects/vault', timestamp }].map(entry => JSON.stringify(entry)).join('\n'));
    assert.equal(parseSessionFile(file), null);
    assert.equal(parseSessionFileForSearch(file, { sessionId: 'leading', headerOnly: true, budget: { remainingBytes: 100_000 } }), null);
  } finally { f.close(); }
});

test('canonical project rejects an unrelated huge payload despite stale SQL scope', () => {
  const f = fixture();
  try {
    const foreign = write(f.root, 'foreign', [message('foreign', 'transcribe huge unrelated')], '/projects/other');
    indexSession(f.db, parseSessionFile(foreign.file)!); upsertSessionFileMetadata(f.db, foreign.file, 'foreign');
    f.db.getDb().prepare("UPDATE sessions SET project='vault' WHERE id='foreign'").run();
    fs.truncateSync(foreign.file, SESSION_SEARCH_MAX_SCAN_BYTES + 1);
    const target = write(f.root, 'target', [message('wanted', 'transcribe wanted')]);
    indexSession(f.db, parseSessionFile(target.file)!); upsertSessionFileMetadata(f.db, target.file, 'target');
    for (const search of [searchSessions, searchSessionEvidence]) {
      const output: any = search(f.db, 'transcribe', { project: 'vault', sessionsDir: f.root });
      const hits = Array.isArray(output) ? output : output.results;
      assert.equal(hits.length, 1); assert.equal(hits[0].entryId, 'wanted'); assert.equal(output.partial, undefined);
    }
  } finally { f.close(); }
});

test('verified partial hits survive a read limit through both formatters and readonly IPC', async () => {
  const f = fixture();
  try {
    const good = write(f.root, 'good', [{ ...message('verified', 'transcribe verified evidence'), timestamp: '2026-10-06T09:00:00Z' }]);
    const large = write(f.root, 'large', [{ ...message('too-large', 'transcribe unseen evidence'), timestamp: '2026-10-06T08:00:00Z' }]);
    for (const source of [good, large]) { const parsed = parseSessionFile(source.file)!; indexSession(f.db, parsed); upsertSessionFileMetadata(f.db, source.file, parsed.id); }
    fs.truncateSync(large.file, SESSION_SEARCH_MAX_SCAN_BYTES + 1);
    const options = { sessionsDir: f.root, project: 'vault', limit: 2 };
    const legacy = searchSessions(f.db, 'transcribe', options);
    assert.equal(legacy.partial, true); assert.equal(legacy[0].entryId, 'verified');
    const structured = searchSessionEvidence(f.db, 'transcribe', options);
    assert.equal(structured.partial, true); assert.equal(structured.results[0].entryId, 'verified');
    for (const output of [formatLegacySearch(legacy, 2, 'transcribe'), formatStructuredSearch(structured)]) {
      assert.equal(output.isError, undefined); assert.equal(output.details.partial, true);
      assert.match(output.content[0].text, /Search incomplete/); assert.match(output.content[0].text, /verified/);
    }
    for (const mode of ['legacy', 'structured'] as const) {
      const output = await runSessionSearch({ mode, dbPath: path.join(f.dir, 'db', 'sessions.db'), query: 'transcribe', options });
      assert.equal(output.details.partial, true); assert.match(output.content[0].text, /Search incomplete/);
      assert.match(output.content[0].text, /verified/);
    }
    const exact = await get(f.db, f.root, 'good', 'verified');
    assert.equal(JSON.parse(exact.content[0].text).entry.content, 'transcribe verified evidence');
    for (const search of [searchSessions, searchSessionEvidence]) {
      assert.throws(() => search(f.db, 'transcribe', { ...options, sessionId: 'large' }), /read limit/);
    }
  } finally { f.close(); }
});

test('large exact get and its local context remain usable under a 256 MiB heap', () => {
  const f = fixture();
  try {
    const target = write(f.root, 'large-get', [message('wanted', 'bounded exact source')]);
    const parsed = parseSessionFile(target.file)!; indexSession(f.db, parsed); upsertSessionFileMetadata(f.db, target.file, parsed.id);
    const padding = 'x'.repeat(2 * 1024 * 1024);
    for (let i = 0; i < 42; i++) fs.appendFileSync(target.file, JSON.stringify({ ...message(`padding-${i}`, padding, 'system'), parentId: i ? `padding-${i - 1}` : 'wanted' }) + '\n');
    const script = `
      import { loadBetterSqlite3 } from './src/store/sqlite-native.ts';
      import { registerSessionGetTool } from './src/tools/session-get-tool.ts';
      const Database = loadBetterSqlite3({ allowRebuild:false });
      const db = new Database(process.argv[1], { readonly:true, fileMustExist:true }); db.exec('PRAGMA query_only=ON');
      let tool; registerSessionGetTool({registerTool:t=>tool=t}, {getDb:()=>db,assertSessionEvidenceAvailable(){}}, {sessionsDir:process.argv[2]});
      const exact = await tool.execute('bounded', {session_id:'large-get',entry_id:'wanted',after:1});
      db.close(); console.log(JSON.stringify(exact.details));
    `;
    const child = spawnSync(process.versions.bun ? 'node' : process.execPath, ['--max-old-space-size=256', '--import', 'tsx', '--input-type=module', '-e', script, path.join(f.dir, 'db', 'sessions.db'), f.root], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.success, true); assert.equal(result.entry.content, 'bounded exact source');
    assert.equal(result.after[0].entry_id, 'padding-0'); assert.equal(result.after[0].content.length, 1_200);
  } finally { f.close(); }
});

test('unknown project checks contained headers without global literal payload scans', () => {
  const f = fixture();
  try {
    const indexed = write(f.root, 'indexed', [message('wanted', 'transcribe known source')]);
    const parsed = parseSessionFile(indexed.file)!; indexSession(f.db, parsed); upsertSessionFileMetadata(f.db, indexed.file, parsed.id);
    write(f.root, 'unregistered', [message('not-indexed', 'transcribe discussed project')], '/projects/discussed-repo');
    for (const search of [searchSessions, searchSessionEvidence]) {
      const output: any = search(f.db, 'transcribe', { project: 'discussed-repo', sessionsDir: f.root });
      assert.equal(output.projectNotFound, true);
      const formatted = Array.isArray(output) ? formatLegacySearch(output, 1, 'transcribe') : formatStructuredSearch(output);
      assert.match(formatted.content[0].text, /conversation cwd/); assert.equal(formatted.details.projectNotFound, true);
      assert.match(searchResultView(formatted).summary, /adjust project/);
    }
    f.db.getDb().prepare("UPDATE sessions SET project='stale' WHERE id='indexed'").run();
    for (const search of [searchSessions, searchSessionEvidence]) {
      const output: any = search(f.db, 'transcribe', { project: 'vault', sessionsDir: f.root });
      const hits = Array.isArray(output) ? output : output.results;
      assert.equal(hits[0]?.entryId, 'wanted'); assert.equal(output.projectNotFound, undefined);
    }
    assert.match(searchResultView({ content: [{ type:'text', text:'Search incomplete' }], details: { success:true, count:1, partial:true } }).summary, /incomplete search/);
  } finally { f.close(); }
});

test('project diagnostics validate owners and remain available with an exact session filter', () => {
  const f = fixture();
  try {
    const source = write(f.root, 'scope-source', [message('wanted', 'project marker')], '/projects/right');
    const parsed = parseSessionFile(source.file)!; indexSession(f.db, parsed); upsertSessionFileMetadata(f.db, source.file, parsed.id);
    for (const state of ['stale-project', 'missing', 'outside']) {
      f.db.getDb().prepare("UPDATE sessions SET project='wrong' WHERE id='scope-source'").run();
      write(f.root, 'scope-source', [message('wanted', 'project marker')], state === 'stale-project' ? '/projects/right' : '/projects/wrong');
      const owner = state === 'missing' ? path.join(f.root, 'missing.jsonl') : state === 'outside' ? path.join(f.dir, 'outside.jsonl') : source.file;
      if (state === 'outside') fs.copyFileSync(source.file, owner);
      f.db.getDb().prepare("UPDATE session_files SET path=? WHERE session_id='scope-source'").run(owner);
      for (const search of [searchSessions, searchSessionEvidence]) {
        const output: any = search(f.db, 'project', { project: 'wrong', sessionsDir: f.root });
        assert.equal(output.projectNotFound, true, state);
      }
      f.db.getDb().prepare("UPDATE session_files SET path=? WHERE session_id='scope-source'").run(source.file);
    }
    write(f.root, 'scope-source', [message('wanted', 'project marker')], '/projects/right');
    for (const search of [searchSessions, searchSessionEvidence]) {
      const output: any = search(f.db, 'project', { project:'wrong', sessionId:'scope-source', sessionsDir:f.root });
      assert.equal(output.projectNotFound, true);
    }
  } finally { f.close(); }
});

test('a named but unavailable persisted source cannot publish ownerless snapshot rows', () => {
  const f = fixture();
  try {
    const header = { id:'not-persisted', timestamp, cwd:'/projects/vault' };
    const entry = message('snapshot-only', 'must wait for persistence');
    for (const state of ['missing', 'malformed', 'outside']) {
      const file = path.join(state === 'outside' ? f.dir : f.root, `${state}.jsonl`);
      if (state === 'malformed') fs.writeFileSync(file, '{}\n');
      if (state === 'outside') fs.writeFileSync(file, JSON.stringify({type:'session',...header})+'\n'+JSON.stringify(entry)+'\n');
      assert.equal(indexLiveSession(f.db, {getSessionFile:()=>file,getHeader:()=>header,getEntries:()=>[entry]}, f.root), null);
      assert.equal((f.db.getDb().prepare('SELECT count(*) AS n FROM sessions WHERE id=?').get(header.id) as any).n, 0);
    }
  } finally { f.close(); }
});

test('structured ambiguous session prefixes remain errors before unknown-project diagnostics', () => {
  const f = fixture();
  try {
    for (const id of ['ambiguous-one', 'ambiguous-two']) {
      const source = write(f.root, id, [message('wanted', 'ambiguity retained')]);
      const parsed = parseSessionFile(source.file)!; indexSession(f.db, parsed); upsertSessionFileMetadata(f.db, source.file, parsed.id);
    }
    const result = searchSessionEvidence(f.db, 'ambiguity', {sessionId:'ambiguous-',project:'absent',sessionsDir:f.root});
    assert.equal(result.ambiguousSessionIds.length, 2); assert.equal(result.projectNotFound, undefined);
  } finally { f.close(); }
});
