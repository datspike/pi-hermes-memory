import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { indexSession, upsertSessionFileMetadata } from '../../src/store/session-indexer.js';
import { searchSessions, searchSessionEvidence, type SessionSearchEvidenceOptions } from '../../src/store/session-search.js';
import { SessionSearchReadLimitError } from '../../src/store/session-parser.js';

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
});
