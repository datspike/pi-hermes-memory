import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseManager } from '../../src/store/db.js';
import { canonicalSessionOwners, indexSession, upsertSessionFileMetadata } from '../../src/store/session-indexer.js';
import { searchSessionAnchors } from '../../src/store/session-anchor-search.js';
import { searchSessions, searchSessionEvidence } from '../../src/store/session-search.js';
import { registerSessionGetTool } from '../../src/tools/session-get-tool.js';

async function runReader(reader: 'owners' | 'legacy' | 'structured' | 'get' | 'anchors', f: ReturnType<typeof fixture>): Promise<any> {
  if (reader === 'owners') return canonicalSessionOwners(f.manager.getDb(), f.header.id, f.sessions);
  if (reader === 'legacy') return searchSessions(f.manager, 'needle', { sessionsDir: f.sessions });
  if (reader === 'structured') return searchSessionEvidence(f.manager, 'needle', { sessionsDir: f.sessions }).results;
  if (reader === 'anchors') return searchSessionAnchors('any:\n- needle', { sessionsDir: f.sessions }).ranges;
  let tool: any; registerSessionGetTool({ registerTool: (definition: any) => { tool = definition; } } as any, f.manager, { sessionsDir: f.sessions });
  return tool.execute('fixture', { session_id: f.header.id, entry_id: 'same-entry' });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-open-'));
  const sessions = path.join(root, 'sessions'); fs.mkdirSync(sessions);
  const file = path.join(sessions, 'owned.jsonl');
  const outside = path.join(root, 'outside.jsonl');
  const header = { type: 'session', id: 'same-session', cwd: '/fixture', timestamp: '2026-10-02T00:00:00Z' };
  const transcript = (content: string) => `${JSON.stringify(content.includes('outside forbidden') ? { ...header, cwd: '/outside-forbidden' } : header)}\n${JSON.stringify({ type: 'message', id: 'same-entry', timestamp: header.timestamp, message: { role: 'user', content } })}\n`;
  fs.writeFileSync(file, transcript('needle inside allowed'));
  fs.writeFileSync(outside, transcript('needle outside forbidden'));
  const manager = new DatabaseManager(root); manager.setQuickCheckOnOpen(false);
  indexSession(manager, { id: header.id, cwd: header.cwd, project: 'fixture', startedAt: header.timestamp, endedAt: null, messages: [{ id: 'same-entry', role: 'user', content: 'needle inside allowed', timestamp: header.timestamp }] });
  upsertSessionFileMetadata(manager, file, header.id);
  return { root, sessions, file, outside, header, manager, cleanup: () => { manager.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

describe('descriptor-bound canonical owners', () => {
  it('does not follow a leaf symlink installed after containment validation', () => {
    const f = fixture(); const realpath = fs.realpathSync.native;
    let swapped = false;
    fs.realpathSync.native = ((candidate: fs.PathLike, ...args: any[]) => {
      const result = realpath(candidate, ...args);
      if (!swapped && String(candidate) === f.file) { swapped = true; fs.unlinkSync(f.file); fs.symlinkSync(f.outside, f.file); }
      return result;
    }) as typeof fs.realpathSync.native;
    try {
      const result = canonicalSessionOwners(f.manager.getDb(), f.header.id, f.sessions);
      assert.equal(swapped, true);
      assert.equal(result.length, 0);
    } finally { fs.realpathSync.native = realpath; f.cleanup(); }
  });
});

// Every public reader must use the same descriptor-bound owner resolver.
for (const reader of ['owners', 'legacy', 'structured', 'get', 'anchors'] as const) {
  for (const replacement of ['leaf', 'parent', 'parent-aba', 'during-read'] as const) {
    it(`${reader} rejects ${replacement} replacement without reading outside payload`, async () => {
      const f = fixture();
      const nativeRealpath = fs.realpathSync.native;
      const nativeOpen = fs.openSync;
      const nativeReadFile = fs.readFileSync;
      const nativeRead = fs.readSync;
      let swapped = false; let outsideReads = 0;
      const parked = path.join(f.root, 'parked');
      const outsideDir = path.join(f.root, 'outside-directory'); fs.mkdirSync(outsideDir);
      fs.copyFileSync(f.outside, path.join(outsideDir, 'owned.jsonl'));
      const swap = () => {
        if (swapped) return; swapped = true;
        if (replacement.startsWith('parent')) { fs.renameSync(f.sessions, parked); fs.symlinkSync(outsideDir, f.sessions); }
        else { fs.renameSync(f.file, parked); fs.symlinkSync(f.outside, f.file); }
      };
      const externalRead = (value: fs.PathOrFileDescriptor): boolean => {
        try {
          const real = nativeRealpath(typeof value === 'number' ? `/proc/self/fd/${value}` : value);
          return real === f.outside || String(real).startsWith(`${outsideDir}${path.sep}`);
        } catch { return false; }
      };
      fs.realpathSync.native = ((candidate: fs.PathLike, ...args: any[]) => {
        const result = nativeRealpath(candidate, ...args);
        if ((replacement === 'leaf' || replacement === 'parent') && String(candidate) === f.file) swap();
        if (replacement === 'during-read' && String(candidate).startsWith('/proc/self/fd/')) swap();
        return result;
      }) as typeof fs.realpathSync.native;
      fs.openSync = ((candidate: fs.PathLike, ...args: any[]) => {
        if (replacement === 'parent-aba' && String(candidate) === f.file && !swapped) {
          swap(); const fd = nativeOpen(candidate, ...args);
          fs.unlinkSync(f.sessions); fs.renameSync(parked, f.sessions); return fd;
        }
        return nativeOpen(candidate, ...args);
      }) as typeof fs.openSync;
      fs.readFileSync = ((candidate: fs.PathOrFileDescriptor, ...args: any[]) => {
        if (replacement === 'during-read' && !swapped && (String(candidate) === f.file || String(candidate).startsWith('/proc/self/fd/'))) swap();
        if (externalRead(candidate)) outsideReads++;
        return nativeReadFile(candidate, ...args);
      }) as typeof fs.readFileSync;
      fs.readSync = ((fd: number, ...args: any[]) => {
        if (replacement === 'during-read' && !swapped) swap();
        if (externalRead(fd)) outsideReads++;
        return nativeRead(fd, ...args);
      }) as typeof fs.readSync;
      syncBuiltinESMExports();
      try {
        const result = await runReader(reader, f);
        assert.equal(swapped, true);
        assert.equal(outsideReads, 0);
        const serialized = JSON.stringify(result);
        assert.doesNotMatch(serialized, /outside[ -]forbidden/);
        // A persistently replaced root or leaf must never publish foreign content.
        // A transient swap that is restored may legitimately expose the original file.
        if (replacement === 'leaf' || replacement === 'parent') {
          if (reader === 'get') assert.equal(result.details.success, false);
          else assert.deepEqual(result, []);
        } else if (serialized.includes('inside allowed')) {
          if (reader === 'get') assert.equal(result.details.success, true);
          else assert.equal(result.length, 1);
        }
      } finally {
        fs.realpathSync.native = nativeRealpath; fs.openSync = nativeOpen; fs.readFileSync = nativeReadFile; fs.readSync = nativeRead; syncBuiltinESMExports(); f.cleanup();
      }
    });
  }
  it(`${reader} still returns an ordinary canonical record`, async () => {
    const f = fixture();
    try {
      const result = await runReader(reader, f);
      if (reader === 'anchors') assert.equal(result[0].path, f.file);
      else assert.match(JSON.stringify(result), /inside allowed/);
      if (reader === 'get') assert.equal(result.details.success, true);
      else assert.equal(result.length, 1);
    } finally { f.cleanup(); }
  });
}

it('preserves ordinary retrieval without an explicit sessions root', () => {
  const f = fixture();
  try { assert.equal(canonicalSessionOwners(f.manager.getDb(), f.header.id)[0].session.id, f.header.id); }
  finally { f.cleanup(); }
});

it('preserves a sessions root legitimately addressed through a symlink', () => {
  const f = fixture(); const alias = path.join(f.root, 'root-alias');
  fs.symlinkSync(f.sessions, alias);
  try {
    assert.equal(canonicalSessionOwners(f.manager.getDb(), f.header.id, alias)[0].path, f.file);
    assert.equal(searchSessions(f.manager, 'needle', { sessionsDir: alias }).length, 1);
    assert.equal(searchSessionEvidence(f.manager, 'needle', { sessionsDir: alias }).results.length, 1);
  } finally { f.cleanup(); }
});

it('fails closed without reading when the descriptor alias cannot be resolved', () => {
  const f = fixture(); const realpath = fs.realpathSync.native; let read = false;
  fs.realpathSync.native = ((candidate: fs.PathLike, ...args: any[]) => {
    if (String(candidate).startsWith('/proc/self/fd/')) throw new Error('descriptor resolution unavailable');
    return realpath(candidate, ...args);
  }) as typeof fs.realpathSync.native;
  try {
    assert.deepEqual(canonicalSessionOwners(f.manager.getDb(), f.header.id, f.sessions, () => { read = true; return null; }), []);
    assert.equal(read, false);
  } finally { fs.realpathSync.native = realpath; f.cleanup(); }
});

it('rejects an in-place rewrite before publishing a parsed owner', () => {
  const f = fixture(); const readFile = fs.readFileSync; let changed = false;
  fs.readFileSync = ((candidate: fs.PathOrFileDescriptor, ...args: any[]) => {
    if (!changed && String(candidate).startsWith('/proc/self/fd/')) {
      changed = true; fs.appendFileSync(f.file, '\n');
    }
    return readFile(candidate, ...args);
  }) as typeof fs.readFileSync;
  try { assert.deepEqual(canonicalSessionOwners(f.manager.getDb(), f.header.id, f.sessions), []); assert.equal(changed, true); }
  finally { fs.readFileSync = readFile; f.cleanup(); }
});

it('anchor mode does not read a leaf replaced after discovery', () => {
  const f = fixture(); const open = fs.openSync; let replaced = false;
  fs.openSync = ((candidate: fs.PathLike, ...args: any[]) => {
    if (String(candidate) === f.file && !replaced) { replaced = true; fs.unlinkSync(f.file); fs.symlinkSync(f.outside, f.file); }
    return open(candidate, ...args);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try {
    const result = searchSessionAnchors('any:\n- needle', { sessionsDir: f.sessions });
    assert.equal(replaced, true);
    assert.equal(result.success, false);
    assert.deepEqual(result.ranges, []);
  } finally { fs.openSync = open; syncBuiltinESMExports(); f.cleanup(); }
});
