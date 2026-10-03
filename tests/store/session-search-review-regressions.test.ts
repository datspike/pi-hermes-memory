import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { canonicalSessionOwners, indexSession, upsertSessionFileMetadata } from '../../src/store/session-indexer.js';
import { searchSessions, searchSessionEvidence, type SessionSearchEvidenceOptions } from '../../src/store/session-search.js';
import { parseSessionFileForSearch, SESSION_SEARCH_MAX_SCAN_BYTES, SessionSearchReadLimitError } from '../../src/store/session-parser.js';

/** Keep the indexed candidate fixed while independently changing its canonical facts. */
describe('canonical search review regressions', () => {
  let dir: string;
  let file: string;
  let manager: DatabaseManager;
  const header = { type: 'session', id: 'review-session', cwd: '/old-project', timestamp: '2026-05-03T00:00:00Z' };
  const record = { type: 'message', id: 'wanted', timestamp: '2026-05-03T00:01:00Z', message: { role: 'user', content: 'needle' } };
  const write = (session: unknown = header, entry: unknown = record) => fs.writeFileSync(file, `${JSON.stringify(session)}\n${JSON.stringify(entry)}\n`);
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-review-'));
    file = path.join(dir, 'canonical.jsonl');
    manager = new DatabaseManager(dir);
    write();
    indexSession(manager, {
      id: header.id, project: 'old-project', cwd: header.cwd, startedAt: header.timestamp, endedAt: null,
      messages: [{ id: record.id, role: 'user', content: 'needle', timestamp: record.timestamp }],
    });
    upsertSessionFileMetadata(manager, file, header.id);
  });
  afterEach(() => { manager.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const search = (options: SessionSearchEvidenceOptions = {}) => searchSessionEvidence(manager, 'needle', { sessionsDir: dir, ...options }).results;

  for (const variant of ['legacy', 'structured'] as const) {
    const execute = (options: SessionSearchEvidenceOptions) => variant === 'legacy'
      ? searchSessions(manager, 'needle', { sessionsDir: dir, ...options })
      : searchSessionEvidence(manager, 'needle', { sessionsDir: dir, ...options }).results;
    it(`${variant} finds a newly matching canonical project without reindexing`, () => {
      write({ ...header, cwd: '/new-project' });
      assert.equal(execute({ project: 'new-project' }).length, 1);
      assert.equal(execute({ project: 'old-project' }).length, 0);
    });
    it(`${variant} finds a newly matching canonical role without reindexing`, () => {
      write(header, { ...record, message: { ...record.message, role: 'assistant' } });
      assert.equal(execute({ role: 'assistant' }).length, 1);
      assert.equal(execute({ role: 'user' }).length, 0);
    });
    it(`${variant} finds a newly matching canonical date without reindexing`, () => {
      write(header, { ...record, timestamp: '2026-05-05T00:00:00Z' });
      assert.equal(execute({ since: '2026-05-04' }).length, 1);
    });
    it(`${variant} uses canonical filters when several facts change together`, () => {
      write({ ...header, cwd: '/new-project' }, { ...record, timestamp: '2026-05-05T00:00:00Z', message: { ...record.message, role: 'assistant' } });
      assert.equal(execute({ project: 'new-project', role: 'assistant', since: '2026-05-04' }).length, 1);
      assert.equal(execute({ project: 'old-project', role: 'assistant', since: '2026-05-04' }).length, 0);
    });
    it(`${variant} applies mutable canonical filters in the literal stop-word fallback`, () => {
      manager.getDb().prepare('UPDATE messages SET content = ?').run('the');
      write({ ...header, cwd: '/new-project' }, { ...record, timestamp: '2026-05-05T00:00:00Z', message: { role: 'assistant', content: 'the' } });
      const options = { sessionsDir: dir, project: 'new-project', role: 'assistant', since: '2026-05-04' };
      const results = variant === 'legacy' ? searchSessions(manager, 'the', options) : searchSessionEvidence(manager, 'the', options).results;
      assert.equal(results.length, 1);
    });
    it(`${variant} fails explicitly rather than hiding scoped hits beyond its candidate window`, () => {
      for (let i = 0; i < 20; i += 1) {
        const id = `foreign-${i}`;
        const foreignFile = path.join(dir, `${id}.jsonl`);
        const timestamp = '2026-05-06T00:00:00Z';
        fs.writeFileSync(foreignFile, `${JSON.stringify({ ...header, id, cwd: '/foreign-project' })}\n${JSON.stringify({ ...record, timestamp })}\n`);
        indexSession(manager, {
          id, project: 'foreign-project', cwd: '/foreign-project', startedAt: header.timestamp, endedAt: null,
          messages: [{ id: record.id, role: 'user', content: 'needle', timestamp }],
        });
        upsertSessionFileMetadata(manager, foreignFile, id);
      }
      write({ ...header, cwd: '/new-project' });
      assert.throws(() => execute({ project: 'new-project', limit: 1 }), SessionSearchReadLimitError);
    });
  }
  it('indexed-only legacy callers retain SQL project, role and date filtering', () => {
    write({ ...header, cwd: '/new-project' }, { ...record, timestamp: '2026-05-05T00:00:00Z', message: { ...record.message, role: 'assistant' } });
    assert.equal(searchSessions(manager, 'needle', { project: 'old-project', role: 'user', since: '2026-05-02' }).length, 1);
    assert.equal(searchSessions(manager, 'needle', { project: 'new-project' }).length, 0);
    assert.equal(searchSessions(manager, 'needle', { role: 'assistant' }).length, 0);
    assert.equal(searchSessions(manager, 'needle', { since: '2026-05-04' }).length, 0);
  });
  it('legacy rejects changed, deleted and replaced canonical entries', () => {
    const legacy = () => searchSessions(manager, 'needle', { sessionsDir: dir });
    assert.equal(legacy().length, 1);
    write(header, { ...record, message: { ...record.message, content: 'other' } });
    assert.equal(legacy().length, 0);
    write(header, { ...record, id: 'replacement' });
    assert.equal(legacy().length, 0);
    fs.writeFileSync(file, `${JSON.stringify(header)}\n`);
    assert.equal(legacy().length, 0);
  });
  it('legacy publishes canonical facts and rechecks role, project and date filters', () => {
    const legacy = (options: SessionSearchEvidenceOptions = {}) => searchSessions(manager, 'needle', { sessionsDir: dir, ...options });
    write({ ...header, cwd: '/new-project' });
    assert.equal(legacy({ project: 'old-project' }).length, 0);
    assert.equal(legacy()[0].project, 'new-project');
    write(header, { ...record, message: { ...record.message, role: 'assistant' } });
    assert.equal(legacy({ role: 'user' }).length, 0);
    assert.equal(legacy()[0].role, 'assistant');
    write(header, { ...record, timestamp: '2026-04-01T00:00:00Z' });
    assert.equal(legacy({ since: '2026-05-02' }).length, 0);
    assert.equal(legacy()[0].timestamp, '2026-04-01T00:00:00Z');
    write(header, { ...record, timestamp: undefined });
    assert.equal(legacy({ since: '2026-05-02' }).length, 0);
    assert.equal(legacy()[0].timestamp, '');
  });
  it('legacy validates the full payload rather than just its displayed prefix', () => {
    const content = `${'x'.repeat(5_000)} needle`;
    manager.getDb().prepare('UPDATE messages SET content = ?').run(content);
    write(header, { ...record, message: { ...record.message, content } });
    const result = searchSessions(manager, 'needle', { sessionsDir: dir });
    assert.equal(result.length, 1);
    assert.equal(result[0].contentChars, content.length);
    assert.ok(result[0].content.length <= 4_000);
    write(header, { ...record, message: { ...record.message, content: `${'x'.repeat(5_000)} other!` } });
    assert.equal(searchSessions(manager, 'needle', { sessionsDir: dir }).length, 0);
  });
  it('legacy rechecks canonical MATCH operators and exact phrases without losing valid changed text', () => {
    const legacy = (query: string) => searchSessions(manager, query, { sessionsDir: dir });
    write(header, { ...record, message: { ...record.message, content: 'needle forbidden' } });
    assert.equal(legacy('needle NOT forbidden').length, 0);
    write(header, { ...record, message: { ...record.message, content: 'alternate' } });
    assert.equal(legacy('needle OR alternate')[0].content, 'alternate');
    manager.getDb().prepare('UPDATE messages SET content = ?').run('needle phrase');
    write(header, { ...record, message: { ...record.message, content: 'needle interrupted phrase' } });
    assert.equal(legacy('"needle phrase"').length, 0);
    write(header, { ...record, message: { ...record.message, content: 'new needle phrase tail' } });
    assert.equal(legacy('"needle phrase"')[0].content, 'new needle phrase tail');
  });
  it('rechecks the role against current JSONL before accepting a hit', () => {
    write(header, { ...record, message: { ...record.message, role: 'assistant' } });
    assert.equal(search({ role: 'user' }).length, 0);
    assert.equal(search()[0].role, 'assistant');
  });
  it('rechecks the project against current JSONL before accepting a hit', () => {
    write({ ...header, cwd: '/new-project' });
    assert.equal(search({ project: 'old-project' }).length, 0);
    assert.equal(search()[0].project, 'new-project');
  });
  it('rechecks the date against current JSONL before accepting a hit', () => {
    write(header, { ...record, timestamp: '2026-04-01T00:00:00Z' });
    assert.equal(search({ since: '2026-05-02' }).length, 0);
    assert.equal(search()[0].timestamp, '2026-04-01T00:00:00Z');
  });
  it('does not use a stale indexed date to satisfy a filter when the canonical date is missing', () => {
    write(header, { ...record, timestamp: undefined });
    assert.equal(search({ since: '2026-05-02' }).length, 0);
    assert.equal(search()[0].timestamp, '');
  });
  it('keeps the matched word in a snippet after case-folding expands Unicode characters', () => {
    const content = `${'İ'.repeat(120)} needle ${'tail'.repeat(120)}`;
    write(header, { ...record, message: { ...record.message, content } });
    const [result] = search({ snippetChars: 80 });
    assert.equal(result.score, 1);
    assert.match(result.snippet, /needle/);
    assert.ok(Array.from(result.snippet).length <= 80);
  });
  it('classifies a service marker beyond the displayed session-name prefix', () => {
    write({ ...header, name: `${'x'.repeat(8_000)} service` });
    assert.equal(search().length, 0);
    assert.equal(search({ includeService: true })[0].name!.length, 1_000);
  });
  it('reports an oversized session identity instead of materializing repeated full IDs', () => {
    const id = 's'.repeat(70_000);
    indexSession(manager, { id, project: 'old-project', cwd: header.cwd, startedAt: header.timestamp, endedAt: null,
      messages: [{ id: 'oversized', role: 'user', content: 'needle', timestamp: record.timestamp }] });
    write({ ...header, id }, { ...record, id: 'oversized' });
    upsertSessionFileMetadata(manager, file, id);
    assert.throws(() => searchSessions(manager, 'needle', { sessionsDir: dir }), SessionSearchReadLimitError);
    assert.throws(() => search(), SessionSearchReadLimitError);
    assert.throws(() => search({ sessionId: 'sss' }), SessionSearchReadLimitError);
  });
  it('reports an oversized entry identity without silently truncating its anchor', () => {
    manager.getDb().prepare('UPDATE messages SET entry_id = ?').run('e'.repeat(70_000));
    assert.throws(() => search(), SessionSearchReadLimitError);
    assert.throws(() => searchSessions(manager, 'needle', { sessionsDir: dir }), SessionSearchReadLimitError);
  });
  it('fetches candidate payloads without acquiring a mutation lease', () => {
    const acquire = manager.acquireMutation;
    manager.acquireMutation = () => { throw new Error('Search must use read-only SQL'); };
    try { assert.equal(search()[0].entryId, record.id); }
    finally { manager.acquireMutation = acquire; }
  });
  it('does not let keys grown after compact selection bypass the allocation budget', () => {
    const db = manager.getDb();
    const getDb = manager.getDb;
    manager.getDb = () => ({ prepare(sql: string) {
      const statement = db.prepare(sql);
      if (!sql.includes('length(m.session_id) AS session_chars')) return statement;
      return { ...statement, all(...args: unknown[]) {
        const rows = statement.all(...args);
        db.prepare('UPDATE messages SET entry_id = ?').run('e'.repeat(60_000));
        return rows;
      }};
    }} as ReturnType<DatabaseManager['getDb']>);
    try { assert.throws(() => search(), SessionSearchReadLimitError); }
    finally { manager.getDb = getDb; }
  });
  it('keeps an individually valid historical long key and anchor exact', () => {
    const id = 'я'.repeat(30_000);
    manager.getDb().prepare('UPDATE messages SET entry_id = ?').run(id);
    write(header, { ...record, id });
    const [result] = search();
    assert.equal(result.entryId, id);
    assert.equal(result.anchor, `pi://session/${header.id}#entry=${id}`);
  });
  it('returns the valid priority owner without reading an over-budget lower owner in either mode', () => {
    const lower = path.join(dir, 'lower.jsonl');
    fs.writeFileSync(lower, `${JSON.stringify(header)}\n${JSON.stringify(record)}\n`);
    // A sparse file exercises the real size guard without allocating a large corpus.
    fs.truncateSync(lower, SESSION_SEARCH_MAX_SCAN_BYTES + 1);
    upsertSessionFileMetadata(manager, lower, header.id);
    manager.getDb().prepare('UPDATE session_files SET indexed_at = ? WHERE path = ?').run('2020-01-01T00:00:00Z', lower);
    assert.equal(searchSessions(manager, 'needle', { sessionsDir: dir })[0].sessionId, header.id);
    assert.equal(search()[0].entryId, record.id);
  });
  it('stops after one valid owner within a shared budget but preserves default full validation', () => {
    const lower = path.join(dir, 'lower.jsonl');
    fs.copyFileSync(file, lower);
    upsertSessionFileMetadata(manager, lower, header.id);
    const db = manager.getDb();
    db.prepare('UPDATE session_files SET indexed_at = ? WHERE path = ?').run('2020-01-01T00:00:00Z', lower);
    const budget = { remainingBytes: fs.statSync(file).size + 1 };
    let attempted: string[] = [];
    const read = (owner: string) => {
      attempted.push(fs.realpathSync.native(owner));
      return parseSessionFileForSearch(owner, { sessionId: header.id, budget });
    };
    assert.equal(canonicalSessionOwners(db, header.id, dir, read, true)[0].path, file);
    assert.deepEqual(attempted, [file]);
    budget.remainingBytes = fs.statSync(file).size + 1;
    attempted = [];
    assert.throws(() => canonicalSessionOwners(db, header.id, dir, read), SessionSearchReadLimitError);
    assert.deepEqual(attempted, [file, lower]);
  });
  it('continues to a valid lower owner when the priority owner has a different header', () => {
    write({ ...header, id: 'wrong-session' });
    const lower = path.join(dir, 'lower.jsonl');
    fs.writeFileSync(lower, `${JSON.stringify(header)}\n${JSON.stringify({ ...record, message: { role: 'user', content: 'needle backup' } })}\n`);
    upsertSessionFileMetadata(manager, lower, header.id);
    manager.getDb().prepare('UPDATE session_files SET indexed_at = ? WHERE path = ?').run('2020-01-01T00:00:00Z', lower);
    assert.equal(searchSessions(manager, 'needle', { sessionsDir: dir })[0].sessionId, header.id);
    assert.equal(search()[0].snippet, 'needle backup');
  });
  it('preserves canonical locale priority for equal indexing timestamps', () => {
    const db = manager.getDb();
    db.prepare('DELETE FROM session_files WHERE path = ?').run(file);
    const paths = ['Z.jsonl', 'a.jsonl'].map(name => path.join(dir, name));
    for (const owner of paths) {
      fs.writeFileSync(owner, `${JSON.stringify(header)}\n${JSON.stringify({ ...record, message: { role: 'user', content: `needle ${path.basename(owner)}` } })}\n`);
      upsertSessionFileMetadata(manager, owner, header.id);
      db.prepare('UPDATE session_files SET indexed_at = ? WHERE path = ?').run('2020-01-01T00:00:00Z', owner);
    }
    const [expected] = paths.sort((a, b) => b.localeCompare(a));
    assert.equal(canonicalSessionOwners(db, header.id, dir)[0].path, expected);
    assert.equal(search()[0].snippet, `needle ${path.basename(expected)}`);
  });
  it('does not let excluded canonical candidates starve a later visible structured hit', () => {
    for (let i = 0; i < 20; i += 1) {
      const id = `tool-${i}`;
      const toolFile = path.join(dir, `${id}.jsonl`);
      const timestamp = `2026-06-0${Math.floor(i / 10) + 1}T00:00:00Z`;
      fs.writeFileSync(toolFile, [
        JSON.stringify({ type: 'session', id, cwd: '/tools', timestamp }),
        JSON.stringify({ type: 'message', id: `tool-entry-${i}`, timestamp, parentId: null, message: { role: 'toolResult', content: [{ type: 'tool_result', toolCallId: `call-${i}`, content: [{ type: 'text', text: 'needle' }] }] } }),
      ].join('\n') + '\n');
      indexSession(manager, {
        id, project: 'tools', cwd: '/tools', startedAt: timestamp, endedAt: null,
        messages: [{ id: `tool-entry-${i}`, entryId: `tool-entry-${i}`, role: 'system', kind: 'tool_result', content: 'needle', timestamp, toolName: null, toolCallId: `call-${i}` }],
      } as any);
      upsertSessionFileMetadata(manager, toolFile, id);
    }
    assert.throws(() => searchSessionEvidence(manager, 'needle', { sessionsDir: dir, limit: 1 }), SessionSearchReadLimitError);
  });
  it('prefers an exact session ID and treats LIKE metacharacters literally in prefixes', () => {
    const add = (id: string) => {
      const sessionFile = path.join(dir, `${id.replace(/[^a-z0-9_-]/gi, '_')}.jsonl`);
      const timestamp = '2026-07-01T00:00:00Z';
      fs.writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id, cwd: '/exact', timestamp })}\n${JSON.stringify({ ...record, id: `${id}-entry`, timestamp })}\n`);
      indexSession(manager, {
        id, project: 'exact', cwd: '/exact', startedAt: timestamp, endedAt: null,
        messages: [{ id: `${id}-entry`, entryId: `${id}-entry`, role: 'user', content: 'needle', timestamp }],
      } as any);
      upsertSessionFileMetadata(manager, sessionFile, id);
    };
    add('abc');
    add('abc-def');
    const exact = search({ sessionId: 'abc' });
    assert.equal(exact.length, 1);
    assert.equal(exact[0].sessionId, 'abc');
    add('wild%one');
    add('wildXone');
    const literalPrefix = search({ sessionId: 'wild%' });
    assert.deepEqual(literalPrefix.map(result => result.sessionId), ['wild%one']);
  });
});
