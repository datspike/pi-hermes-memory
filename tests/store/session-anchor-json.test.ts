import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AnchorStringMatcher } from '../../src/store/session-anchor-string-match.js';
import { readAnchorJson } from '../../src/store/session-anchor-json.js';

function collect(value: unknown, parts: string[], key?: string): void {
  const ignored = ['type', 'id', 'parentId', 'sessionId', 'session_id', 'timestamp', 'cwd', 'role', 'customType'];
  if (typeof value === 'string') { if (!key || !ignored.includes(key)) parts.push(value); }
  else if (Array.isArray(value)) { for (const item of value) collect(item, parts, key); }
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) collect(item, parts, key);
}

for (const locale of ['en-US', 'el', 'tr', 'az', 'lt']) {
  test(`streamed casing matches native substring semantics in ${locale}`, () => {
    const terms = ['needle', 'σ', 'ς', 'οσ', 'ος', 'i', 'ı', 'i\u0307', 'j\u0307', 'į\u0307', '𐐨', '\ud801', 'abc'].map(text => text.toLocaleLowerCase(locale));
    const samples = ['NEEDLE', 'ΟΣ', 'ΟΣΑ', 'Σ', 'AΣ\u0345\u0301Α', 'AΣ\u0345\u0301 ', 'I\u0323\u0307', 'I\u0301\u0307', 'I\u034f\u0307', 'I\u0307\u0307', 'J\u0323\u0301', 'Į\u0301', 'ÌÍĨİ', '𐐀', '\ud801', '\ud801\udc00', 'abc\nΣ'];
    let state = 42;
    const chars = ['A', 'B', 'I', 'J', 'Į', 'İ', 'Ο', 'Σ', 'σ', 'ς', '\u0323', '\u0301', '\u0307', '\u0345', '\u034f', "'", ' ', '𐐀', '\ud801', '\udc00'];
    for (let i = 0; i < 80; i++) {
      let value = '';
      for (let j = 0; j < 25; j++) { state = (state * 1664525 + 1013904223) >>> 0; value += chars[state % chars.length]; }
      samples.push(value);
    }
    for (const text of samples) {
      const lower = text.toLocaleLowerCase(locale);
      const expected = terms.reduce((bits, term, i) => lower.includes(term) ? bits | (1n << BigInt(i)) : bits, 0n);
      for (const size of [1, 2, 3, 17]) {
        const matcher = new AnchorStringMatcher(terms, locale);
        for (let i = 0; i < text.length; i += size) matcher.feed(text.slice(i, i + size));
        assert.equal(matcher.finish(), expected, JSON.stringify({ locale, text, size }));
      }
    }
  });
}

test('streamed JSON preserves last decoded keys, nested text, metadata arrays, and escaped surrogates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-json-semantics-'));
  const file = path.join(root, 'events.jsonl');
  const terms = ['needle', 'drop', 'keep', '𐐨', 'ος', '/work', 'root', 'Σ'].map(term => term.toLocaleLowerCase());
  const records = [
    '{"x":"drop","x":"needle"}',
    '{"x":"needle","\\u0078":"drop"}',
    '{"x":{"a":"drop"},"x":{"b":"needle"}}',
    '{"type":["drop",["drop"],{"x":"needle"}],"id":"drop","role":"drop"}',
    '{"type":{"x":"needle"},"value":[["keep"],null,true,1e9999]}',
    '{"type":"session","id":"root","cwd":"/work","message":{"timestamp":"2026-05-15T10:00:00Z","content":"\\ud801\\udc00 ΟΣ"}}',
    '["needle",{"x":"keep"}]',
    '"needle"', 'null', 'false', '-12.34e+9999',
    '{"__proto__":{"x":"needle"},"constructor":"keep"}',
    '{"' + 'x'.repeat(80) + '":"needle","' + 'x'.repeat(80) + '":"drop"}',
  ];
  try {
    fs.writeFileSync(file, records.join('\r\n'));
    let i = 0;
    for (const source of readAnchorJson(file, terms)) {
      const actual = source.parse();
      const parts: string[] = [];
      collect(JSON.parse(records[i]), parts);
      const text = parts.join('\n').toLocaleLowerCase();
      const expected = terms.reduce((bits, term, j) => text.includes(term) ? bits | (1n << BigInt(j)) : bits, 0n);
      assert.equal(actual.flags, expected, records[i]);
      assert.equal(source.line, ++i);
      if (i === 6) {
        assert.equal(actual.fields?.id.value, 'root');
        assert.equal(actual.fields?.cwd.value, '/work');
        assert.equal(actual.fields?.message.fields?.timestamp.value, '2026-05-15T10:00:00Z');
      }
    }
    assert.equal(i, records.length);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('streamed JSON rejects malformed grammar with the same physical line', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-json-invalid-'));
  const file = path.join(root, 'bad.jsonl');
  const records = ['[1,]', '{"x":1,}', '{x:1}', '{"x" 1}', '01', '-01', '1.', '1e+', 'tru', 'null false', '"\\x"', '"\\u123x"', '"a\tb"', '{"x":"unfinished', '\u00a0{}', '{}\u00a0', '[\n]'];
  try {
    for (const record of records) {
      fs.writeFileSync(file, '\n \t\r\n' + record);
      const iterator = readAnchorJson(file, ['needle']);
      const source = iterator.next().value!;
      assert.equal(source.line, 3);
      assert.throws(() => source.parse(), SyntaxError, record);
      iterator.return();
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('long contextual casing runs match native results across decoded-block boundaries', () => {
  const samples = [
    'ΟΣ' + "'".repeat(65538) + 'Α',
    'Ο' + 'Σ'.repeat(65539),
    'I' + '\u0323\u0345'.repeat(33000) + '\u0307',
    'J' + '\u0323\u0345'.repeat(33000) + '\u0301',
  ];
  for (const locale of ['en-US', 'el', 'tr', 'az', 'lt']) {
    const terms = ['σ', 'ς', 'ı', 'i', 'i\u0307', 'j\u0307', 'į\u0307', 'abc'].map(term => term.toLocaleLowerCase(locale));
    for (const sample of samples) {
      const lower = sample.toLocaleLowerCase(locale);
      const expected = terms.reduce((bits, term, i) => lower.includes(term) ? bits | (1n << BigInt(i)) : bits, 0n);
      for (const size of [511, 64 * 1024]) {
        const matcher = new AnchorStringMatcher(terms, locale);
        for (let i = 0; i < sample.length; i += size) matcher.feed(sample.slice(i, i + size));
        assert.equal(matcher.finish(), expected, JSON.stringify({ locale, size, prefix: sample.slice(0, 3) }));
      }
    }
  }
});
