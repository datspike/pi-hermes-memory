import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionEntries, parseSessionFile, resolveActiveLineage } from '../../src/store/session-parser.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const session = (lines: string[]) => [JSON.stringify({ type: 'session', id: 'session-a', cwd: '/work/demo', timestamp: '2026-08-09T00:00:00.000Z' }), ...lines].join('\n');
const message = (id: string | undefined, content: string, parentId: string | null = null) => JSON.stringify({ type: 'message', ...(id ? { id } : {}), parentId, timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'user', content } });

function parseText(content: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, content);
  const result = parseSessionFile(file);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(result);
  return result;
}

describe('logical session parser', () => {
  it('preserves native IDs and exposes metadata, tool identity and graph fields', () => {
    const result = parseText(session([
      JSON.stringify({ type: 'session_info', id: 'info-1', name: 'Readable title', title: 'Title' }),
      JSON.stringify({ type: 'message', id: 'native-1', parentId: null, timestamp: '2026-08-09T00:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }, { type: 'tool_use', name: 'memory_search' }] } }),
      JSON.stringify({ type: 'session_info', id: 'info-2', name: '' }),
    ]));
    assert.equal(result.name, null);
    assert.equal(result.title, 'Title');
    assert.equal(result.messages[0].entryId, 'native-1');
    assert.equal(result.messages[0].identityStatus, 'native');
    assert.equal(result.messages[0].toolName, 'memory_search');
    assert.equal(result.messages[0].parentEntryId, 'root');
    assert.ok(result.entries?.some((entry) => entry.kind === 'session_info'));
  });

  it('keeps synthetic IDs stable across unrelated structural and malformed insertion', () => {
    const first = parseSessionEntries(session([message(undefined, 'same payload')]), 'session-a').find((entry) => entry.kind === 'message');
    const second = parseSessionEntries(session(['{ malformed', '\u0000not-json', JSON.stringify({ type: 'model_change', id: 'structural-1', timestamp: '2026-08-09T00:00:30.000Z' }), message(undefined, 'same payload')]), 'session-a').find((entry) => entry.kind === 'message');
    assert.ok(first?.entryId?.startsWith('syn:v1:'));
    assert.equal(first?.entryId, second?.entryId);
  });

  it('fails closed for repeated identical synthetic payloads and duplicate native IDs', () => {
    const repeated = parseSessionEntries(session([message(undefined, 'same'), message(undefined, 'same')]), 'session-a').filter((entry) => entry.kind === 'message');
    assert.ok(repeated.every((entry) => entry.identityStatus === 'ambiguous'));
    const duplicateNative = parseSessionEntries(session([message('same-id', 'one'), message('same-id', 'two')]), 'session-a').filter((entry) => entry.kind === 'message');
    assert.ok(duplicateNative.every((entry) => entry.identityStatus === 'ambiguous'));
    assert.equal(parseSessionEntries(session([message('same-id', 'one')]), 'session-b').find((entry) => entry.kind === 'message')?.identityStatus, 'native');
  });

  it('records malformed/NUL diagnostics and rejects unsafe graph branches', () => {
    const result = parseText(session(['{ malformed', '\u0000bad', JSON.stringify({ type: 'message', id: 'child', parentId: 'missing', timestamp: '2026-08-09T00:02:00.000Z', message: { role: 'user', content: 'child' } })]));
    assert.equal(result.diagnostics?.malformedLines, 1);
    assert.equal(result.diagnostics?.nulLines, 1);
    assert.deepEqual(resolveActiveLineage(result.entries ?? []), null);
  });

  it('checks a long linear graph without quadratic slowdown', () => {
    const entries: string[] = [];
    let parentId: string | null = null;
    for (let index = 0; index < 15_000; index++) {
      const id = `entry-${index}`;
      entries.push(JSON.stringify({
        type: 'custom',
        id,
        parentId,
        timestamp: '2026-08-26T00:01:00.000Z',
        customType: 'benchmark',
        data: {},
      }));
      parentId = id;
    }

    const started = performance.now();
    const result = parseText(session(entries));
    const elapsedMs = performance.now() - started;

    assert.equal(result.entries?.length, 15_001);
    assert.deepEqual(result.diagnostics?.cycles, []);
    assert.ok(elapsedMs < 1_500, `linear graph diagnostics took ${Math.round(elapsedMs)} ms`);
  });
});
