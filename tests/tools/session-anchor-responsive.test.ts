import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerSessionSearchTool } from '../../src/tools/session-search-tool.js';
import { runSessionSearch } from '../../src/store/session-search-async.js';

/** Reproduce a valid large input without allocating its complete contents in the test. */
function largeAnchorFixture(matchedPadding: boolean, singleLine = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-large-anchors-'));
  const file = path.join(root, 'session.jsonl');
  const fd = fs.openSync(file, 'w');
  try {
    if (singleLine) {
      fs.writeSync(fd, '{"type":"custom","data":"needle');
      const padding = 'x'.repeat(512 * 1024);
      for (let i = 0; i < 560; i++) fs.writeSync(fd, padding);
      fs.writeSync(fd, '"}\n');
    } else {
      fs.writeSync(fd, JSON.stringify({ type: 'message', message: { role: 'user', content: 'needle' } }) + '\n');
      const padding = JSON.stringify({ type: 'custom', data: (matchedPadding ? 'needle' : '') + 'x'.repeat(512 * 1024) }) + '\n';
      for (let i = 0; i < 560; i++) fs.writeSync(fd, padding);
    }
  } finally { fs.closeSync(fd); }
  return { root, file, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

for (const matchedPadding of [false, true]) {
  test(`large anchors input with ${matchedPadding ? 'contiguous matched' : 'unmatched'} padding returns one small exact range`, { timeout: 60_000 }, async () => {
    const f = largeAnchorFixture(matchedPadding);
    let tool: any;
    const unopened = { getPath() { assert.fail('anchors accessed the indexed DB'); } };
    registerSessionSearchTool({ registerTool: (definition: any) => { tool = definition; } } as any, unopened as any, { variant: 'anchors' }, { sessionsDir: f.root });
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    try {
      assert.ok(fs.statSync(f.file).size > 280 * 1024 * 1024);
      const result = await tool.execute('large-anchor-input', { markdown: 'any:\n- needle' });
      assert.equal(result.details.success, true);
      assert.equal(result.details.count, 1);
      assert.equal(result.details.ranges[0].path, f.file);
      assert.equal(result.details.ranges[0].startLine, 1);
      assert.equal(result.details.ranges[0].endLine, matchedPadding ? 561 : 1);
      assert.ok(Buffer.byteLength(JSON.stringify({ type: 'result', ok: true, result }), 'utf8') < 1024);
      assert.ok(ticks > 0, 'large anchors input blocked the parent event loop');
    } finally { clearInterval(timer); f.cleanup(); }
  });
}

test('one valid 280 MiB JSONL record returns a compact exact range under the child heap guard', { timeout: 60_000 }, async () => {
  const f = largeAnchorFixture(true, true);
  try {
    const result = await runSessionSearch({ mode: 'anchors', markdown: 'any:\n- needle', sessionsDir: f.root });
    assert.equal(result.details.success, true);
    assert.equal(result.details.count, 1);
    assert.deepEqual(result.details.ranges[0], { path: f.file, startLine: 1, endLine: 1, score: 1, reason: 'matched any: needle' });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024);
    // An early match must not bypass validation at the far end of the string.
    const fd = fs.openSync(f.file, 'r+');
    try { fs.writeSync(fd, '\\x"}\n', fs.statSync(f.file).size - 3); } finally { fs.closeSync(fd); }
    const invalid = await runSessionSearch({ mode: 'anchors', markdown: 'any:\n- needle', sessionsDir: f.root });
    assert.equal(invalid.details.success, false);
    assert.equal(invalid.details.count, undefined);
    assert.equal(invalid.details.message, `Invalid JSON in ${f.file}:1`);
  } finally { f.cleanup(); }
});

test('five million matching properties retain one range without exhausting the child heap', { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-many-anchor-properties-'));
  const file = path.join(root, 'session.jsonl');
  try {
    const fd = fs.openSync(file, 'w');
    try {
      fs.writeSync(fd, '{');
      for (let i = 0; i < 5_000_000; i += 1000) fs.writeSync(fd, Array.from({ length: 1000 }, (_, j) => `${i + j ? ',' : ''}"p${i + j}":"needle"`).join(''));
      fs.writeSync(fd, '}\n');
    } finally { fs.closeSync(fd); }
    const result = await runSessionSearch({ mode: 'anchors', markdown: 'any:\n- needle', sessionsDir: root });
    assert.equal(result.details.count, 1);
    assert.deepEqual(result.details.ranges[0], { path: file, startLine: 1, endLine: 1, score: 1, reason: 'matched any: needle' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('escape-heavy large metadata produces the agreed response-limit error, not OOM', { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-escaped-anchor-metadata-'));
  const file = path.join(root, 'session.jsonl');
  try {
    const fd = fs.openSync(file, 'w');
    try {
      fs.writeSync(fd, '{"type":"session","id":"');
      const chunk = '\\u0078'.repeat(64 * 1024);
      for (let i = 0; i < 171; i++) fs.writeSync(fd, chunk);
      fs.writeSync(fd, '","message":{"content":"needle"}}\n');
    } finally { fs.closeSync(fd); }
    await assert.rejects(runSessionSearch({ mode: 'anchors', markdown: 'any:\n- needle', sessionsDir: root }), (error: any) => error.code === 'SESSION_SEARCH_RESPONSE_LIMIT');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
