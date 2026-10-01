import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnchorMemberMatches } from '../../src/store/session-anchor-members.js';

for (const terms of [0, 1, 9, 65]) {
  test(`compact duplicate-key storage preserves ${terms} term bits across replacement, deletion and growth`, () => {
    const actual = new AnchorMemberMatches(terms, 4);
    const expected = new Map<string, bigint>();
    const check = () => assert.equal(actual.flags, [...expected.values()].reduce((bits, flags) => bits | flags, 0n));
    const set = (key: string, flags: bigint) => { actual.set(key, flags); expected.set(key, flags); };
    for (let i = 0; i < 2000; i++) {
      set(`key-${i}`, terms ? (1n << BigInt(i % terms)) | (1n << BigInt(terms - 1)) : 0n);
      if (i % 99 === 0) check();
    }
    check();
    for (let i = 0; i < 2000; i += 2) set(`key-${i}`, 0n);
    check();
    for (let i = 1; i < 2000; i += 2) set(`key-${i}`, 0n);
    check();
    assert.equal(actual.flags, 0n);
    for (let i = 0; i < 2000; i++) set(`key-${i}`, terms ? 1n << BigInt(i % terms) : 0n);
    check();
    for (let i = 0; i < 2000; i++) set(`new-key-${i}`, terms ? 1n << BigInt(terms - 1) : 0n);
    check();
  });
}
