import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAnchorSearch, formatLegacySearch, formatStructuredSearch } from '../../src/store/session-search-output.js';

const MAX_BYTES = 1024 * 1024;
const packetBytes = (result: unknown) => Buffer.byteLength(JSON.stringify({ type: 'result', ok: true, result }), 'utf8');
const isLimitError = (error: any) => error.name === 'SessionSearchResponseLimitError' && error.code === 'SESSION_SEARCH_RESPONSE_LIMIT' && /1 MiB.*narrow/i.test(error.message);
const isStructuredLimitError = (error: any) => error.name === 'SessionSearchResponseLimitError' && error.code === 'SESSION_SEARCH_RESPONSE_LIMIT' && /structured.*response|narrow.*query/i.test(error.message);

test('anchors retain all 100 long paths and exact ranges within the response budget', () => {
  const ranges = Array.from({ length: 100 }, (_, i) => ({ path: `/sessions/${'p'.repeat(800)}/${i}.jsonl`, startLine: 2, endLine: 3, reason: 'matched needle' }));
  const result = formatAnchorSearch({ success: true, ranges });
  assert.equal(result.details.count, 100);
  assert.deepEqual(result.details.ranges, ranges);
  assert.equal(result.details.output, result.content[0].text);
  assert.ok(packetBytes(result) < MAX_BYTES);
  for (const range of ranges) assert.ok(result.content[0].text.includes(`${range.path}:2-3`));
});

test('anchors reject large metadata reasons before serializing a reply', () => {
  const stringify = JSON.stringify;
  JSON.stringify = (() => { assert.fail('oversized metadata reached serialization'); }) as typeof JSON.stringify;
  try {
    assert.throws(() => formatAnchorSearch({ success: true, ranges: [{ path: '/session.jsonl', startLine: 2, endLine: 2, reason: 'x'.repeat(MAX_BYTES + 1) }] }), isLimitError);
  } finally { JSON.stringify = stringify; }
});

test('anchors count all metadata fields and reject the complete reply rather than dropping ranges', () => {
  const ranges = Array.from({ length: 100 }, (_, i) => ({ path: `/session-${i}.jsonl`, startLine: 2, endLine: 2, cwd: 'c'.repeat(12_000), reason: 'needle' }));
  assert.throws(() => formatAnchorSearch({ success: true, ranges }), isLimitError);
});

test('anchors enforce UTF-8 bytes including repeated output and JSON escaping', () => {
  const ranges = Array.from({ length: 100 }, (_, i) => ({ path: `/sessions/${'😀'.repeat(950)}/${i}.jsonl`, startLine: 2, endLine: 2, reason: 'needle' }));
  assert.throws(() => formatAnchorSearch({ success: true, ranges }), isLimitError);
  assert.throws(() => formatAnchorSearch({ success: false, ranges: [], message: '\u0000'.repeat(100_000) }), isLimitError);
});

test('anchors include the IPC envelope in the exact byte boundary, also for validation failures', () => {
  const empty = formatAnchorSearch({ success: false, ranges: [], message: 'x' });
  const overhead = packetBytes(empty) - 2;
  const size = Math.floor((MAX_BYTES - overhead) / 2);
  const allowed = formatAnchorSearch({ success: false, ranges: [], message: 'x'.repeat(size) });
  assert.ok(packetBytes(allowed) <= MAX_BYTES);
  assert.ok(MAX_BYTES - packetBytes(allowed) <= 1);
  assert.throws(() => formatAnchorSearch({ success: false, ranges: [], message: 'x'.repeat(size + 1) }), isLimitError);
});

test('structured search rejects a valid oversized identity instead of returning an empty success', () => {
  const sessionId = 's'.repeat(60_000);
  assert.throws(() => formatStructuredSearch({ results: [{
    sessionId, entryId: 'entry', project: 'project', cwd: '/work/project', name: null, role: 'user', kind: 'message',
    tool: null, tool_call_id: null, timestamp: '2026-09-30T00:00:00Z', snippet: 'needle', score: 1, scoreMode: 'like',
    anchor: `pi://session/${sessionId}#entry=entry`,
  }], ambiguousSessionIds: [] }), isStructuredLimitError);
});

test('all formatter failures retain their details and native error status', () => {
  const failures = [
    formatLegacySearch([], 0, 'needle'),
    formatStructuredSearch({ results: [], ambiguousSessionIds: ['session-a', 'session-b'] }),
    formatAnchorSearch({ success: false, ranges: [], message: 'Invalid control request.' }),
  ];
  for (const result of failures) {
    assert.equal(result.details.success, false);
    assert.equal(result.isError, true);
  }
  const successes = [
    formatLegacySearch([], 1, 'needle'),
    formatStructuredSearch({ results: [], ambiguousSessionIds: [] }),
    formatAnchorSearch({ success: true, ranges: [] }),
  ];
  for (const result of successes) {
    assert.equal(result.details.success, true);
    assert.notEqual(result.isError, true);
  }
});
