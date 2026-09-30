import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseSessionFile, parseSessionFileForSearch, SessionSearchReadLimitError,
  SESSION_SEARCH_MAX_LINE_BYTES, SESSION_SEARCH_MAX_SCAN_BYTES,
} from '../../src/store/session-parser.js';

const header = { type: 'session', id: 'reader-session', cwd: '/reader-project', timestamp: '2026-05-03T00:00:00Z' };
const message = (id: string, content: string) => ({ type: 'message', id, timestamp: '2026-05-03T00:01:00Z', message: { role: 'user', content } });

describe('bounded canonical search reader', () => {
  let dir: string;
  let file: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-reader-')); file = path.join(dir, 'session.jsonl'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (records: unknown[]) => fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const read = (ids: string[] = [], remainingBytes = SESSION_SEARCH_MAX_SCAN_BYTES) => parseSessionFileForSearch(file, {
    sessionId: header.id, entryIds: new Set(ids), budget: { remainingBytes },
  });

  it('retains only requested entries and preserves the canonical identity and latest metadata', () => {
    write([header, message('ignored', 'unrelated'), message('wanted', 'needle'),
      { type: 'session_info', name: 'service consolidation', title: 'latest title' },
      { type: 'session_info', name: '' }]);
    const expected = parseSessionFile(file)!;
    const actual = read(['wanted'])!;
    assert.equal(actual.id, expected.id);
    assert.equal(actual.cwd, expected.cwd);
    assert.equal(actual.name, null);
    assert.equal(actual.title, expected.title);
    assert.deepEqual(actual.entries, expected.entries!.filter(entry => entry.entryId === 'wanted'));
    assert.deepEqual(actual.messages, []);
  });

  it('preserves synthetic IDs including ordinal-parent mappings', () => {
    const first = { ...message('', 'synthetic first'), id: undefined, parentId: null };
    const second = { ...message('', 'synthetic second'), id: undefined, parentId: 'ordinal:1' };
    write([header, first, second]);
    const expected = parseSessionFile(file)!.entries!.filter(entry => entry.identityStatus === 'synthetic');
    assert.equal(expected.length, 2);
    const actual = read(expected.map(entry => entry.entryId!))!;
    assert.deepEqual(actual.entries, expected);
  });

  it('fails closed for duplicate requested identities, including duplicates after the first hit', () => {
    write([header, message('wanted', 'needle'), message('wanted', 'different content')]);
    const result = read(['wanted'])!;
    assert.equal(result.entries!.length, 1);
    assert.equal(result.entries![0].identityStatus, 'ambiguous');
  });

  it('preserves UTF-8 across chunk boundaries and accepts a final line without a newline', () => {
    fs.writeFileSync(file, JSON.stringify(header) + '\n' + JSON.stringify(message('wanted', '😀я'.repeat(18_000) + ' tail')));
    const result = read(['wanted'])!;
    assert.equal(result.entries![0].content, ('😀я'.repeat(18_000) + ' tail').slice(0, 4_000));
    assert.doesNotMatch(result.entries![0].content, /�/);
  });

  it('counts malformed and NUL lines without exposing their content', () => {
    fs.writeFileSync(file, `${JSON.stringify(header)}\n{invalid\n\0\n${JSON.stringify(message('wanted', 'needle'))}\n`);
    const result = read(['wanted'])!;
    assert.equal(result.diagnostics!.malformedLines, 1);
    assert.equal(result.diagnostics!.nulLines, 1);
    assert.equal(result.entries![0].ordinal, 1);
  });

  it('rejects a mismatched header instead of trusting the index owner', () => {
    write([{ ...header, id: 'different-session' }, message('wanted', 'needle')]);
    assert.equal(read(['wanted']), null);
  });

  it('shares the byte budget across reads and does not silently truncate a transcript', () => {
    write([header, message('wanted', 'needle')]);
    const budget = { remainingBytes: fs.statSync(file).size };
    assert.ok(parseSessionFileForSearch(file, { sessionId: header.id, budget }));
    assert.equal(budget.remainingBytes, 0);
    assert.throws(() => parseSessionFileForSearch(file, { sessionId: header.id, budget }), SessionSearchReadLimitError);
  });

  it('rejects oversized lines before JSON.parse instead of risking an allocation failure', () => {
    write([header]);
    const fd = fs.openSync(file, 'a');
    try {
      const chunk = Buffer.alloc(64 * 1024, 120);
      for (let bytes = 0; bytes <= SESSION_SEARCH_MAX_LINE_BYTES; bytes += chunk.length) fs.writeSync(fd, chunk);
      fs.writeSync(fd, '\n');
    } finally { fs.closeSync(fd); }
    assert.throws(() => read(), SessionSearchReadLimitError);
  });

  it('rejects snapshots that change while a matching entry is being read', () => {
    write([header, message('wanted', 'needle')]);
    const result = parseSessionFileForSearch(file, {
      sessionId: header.id, entryIds: new Set(['wanted']), budget: { remainingBytes: SESSION_SEARCH_MAX_SCAN_BYTES },
      transformEntry: entry => { fs.appendFileSync(file, '\n'); return entry; },
    });
    assert.equal(result, null);
  });
});
