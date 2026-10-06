import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseManager } from '../../src/store/db.js';
import { indexSession } from '../../src/store/session-indexer.js';
import { registerSessionSearchTool } from '../../src/tools/session-search-tool.js';

function fixture(paddingChunks = 128) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-responsive-'));
  const manager = new DatabaseManager(root);
  const file = path.join(root, 'session.jsonl');
  const id = 'responsive-session';
  const entryId = 'responsive-entry';
  const timestamp = '2026-09-30T00:00:00Z';
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, JSON.stringify({ type: 'session', id, cwd: '/work/responsive', timestamp }) + '\n');
  fs.writeSync(fd, JSON.stringify({ type: 'message', id: entryId, timestamp, message: { role: 'user', content: 'responsive needle' } }) + '\n');
  const filler = JSON.stringify({ type: 'custom', id: 'padding', data: 'x'.repeat(512 * 1024) }) + '\n';
  for (let i = 0; i < paddingChunks; i++) fs.writeSync(fd, filler);
  fs.closeSync(fd);
  indexSession(manager, { id, project: 'responsive', cwd: '/work/responsive', startedAt: timestamp, endedAt: null, messages: [{ id: entryId, role: 'user', content: 'responsive needle', timestamp }] });
  const stat = fs.statSync(file);
  manager.getDb().prepare('INSERT INTO session_files (path, session_id, size, mtime_ms, indexed_at) VALUES (?, ?, ?, ?, ?)').run(file, id, stat.size, stat.mtimeMs, timestamp);
  return { root, manager, cleanup: () => { manager.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

// A slow timestamp expression keeps sqlite3_step active after startup completes.
function slowNativeStatement(manager: DatabaseManager): void {
  const db = manager.getDb();
  const columns = (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(row => row.name);
  db.exec('ALTER TABLE messages RENAME TO stored_messages');
  const expensive = '(WITH RECURSIVE nums(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM nums WHERE x<20000000) SELECT sum(x) FROM nums)';
  db.exec(`CREATE VIEW messages AS SELECT rowid AS rowid, ${columns.map(name => name === 'timestamp' ? `CASE WHEN ${expensive} > 0 THEN timestamp END AS timestamp` : `"${name}"`).join(', ')} FROM stored_messages`);
}

/** Hold a real SQLite lock while the tool's managed connection remains unopened. */
function lockedColdManager() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cold-lock-'));
  const manager = new DatabaseManager(root);
  const module = createRequire(import.meta.url)('Bun' in globalThis ? 'bun:sqlite' : 'better-sqlite3');
  const Database = module.Database ?? module;
  const locker = new Database(manager.getPath());
  locker.exec('PRAGMA journal_mode=DELETE; CREATE TABLE extension_metadata (key TEXT PRIMARY KEY, value TEXT)');
  const before = fs.readFileSync(manager.getPath());
  locker.exec('BEGIN EXCLUSIVE');
  return { root, manager, cleanup: () => {
    locker.exec('ROLLBACK');
    locker.close();
    // Closing any FD for a SQLite file can release POSIX locks: inspect bytes only after unlocking.
    try { assert.deepEqual(fs.readFileSync(manager.getPath()), before, 'search wrote to the database'); }
    finally { manager.close(); fs.rmSync(root, { recursive: true, force: true }); }
  } };
}

test('legacy session_search keeps the parent event loop responsive while validating a large transcript', async () => {
  const f = fixture();
  let tool: any;
  registerSessionSearchTool({ registerTool: (definition: any) => { tool = definition; } } as any, f.manager, { variant: 'legacy' }, { sessionsDir: f.root });
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  try {
    const result = await tool.execute('responsive', { query: 'needle', limit: 1 });
    assert.equal(result.details.count, 1);
    assert.match(result.content[0].text, /responsive needle/);
    assert.ok(ticks > 0, 'session_search monopolized the parent event loop');
  } finally {
    clearInterval(timer);
    f.cleanup();
  }
});

test('session_search reports an active search, cancels it, and allows a subsequent search', async () => {
  const f = fixture();
  let tool: any;
  registerSessionSearchTool({ registerTool: (definition: any) => { tool = definition; } } as any, f.manager, { variant: 'legacy' }, { sessionsDir: f.root });
  const controller = new AbortController();
  let progress = false;
  try {
    await assert.rejects(tool.execute('cancel', { query: 'needle' }, controller.signal, (update: any) => {
      if (update.details.phase === 'searching') { progress = true; controller.abort(); }
    }), (error: any) => error.name === 'AbortError' && error.code === 'ABORT_ERR');
    assert.equal(progress, true);
    const subsequent = await tool.execute('after-cancel', { query: 'needle', limit: 1 });
    assert.equal(subsequent.details.count, 1);
  } finally { f.cleanup(); }
});

test('cancellation interrupts an active native SQLite statement rather than waiting for it', async () => {
  const f = fixture();
  let tool: any;
  slowNativeStatement(f.manager);
  registerSessionSearchTool({ registerTool: (definition: any) => { tool = definition; } } as any, f.manager, { variant: 'legacy' }, { sessionsDir: f.root });
  const controller = new AbortController();
  let abortAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(tool.execute('native-cancel', { query: 'needle' }, controller.signal, () => {
      timer = setTimeout(() => { abortAt = performance.now(); controller.abort(); }, 100);
    }), (error: any) => error.name === 'AbortError');
    assert.ok(abortAt > 0);
    assert.ok(performance.now() - abortAt < 1_000, 'cancellation waited for the native SQLite statement');
  } finally { clearTimeout(timer); f.cleanup(); }
});

test('already cancelled searches do not access the DB or start a child in any mode', async () => {
  const controller = new AbortController();
  controller.abort();
  const untouchedManager = { assertSessionEvidenceAvailable() { assert.fail('cancelled search accessed the DB'); }, getPath() { assert.fail('cancelled search requested a DB path'); } };
  for (const variant of ['legacy', 'structured', 'anchors'] as const) {
    let tool: any;
    registerSessionSearchTool({ registerTool: (definition: any) => { tool = definition; } } as any, untouchedManager as any, { variant }, { sessionsDir: '/unopened' });
    await assert.rejects(tool.execute('cancelled', variant === 'anchors' ? { markdown: 'any:\n- needle' } : { query: 'needle' }, controller.signal), (error: any) => error.name === 'AbortError' && error.code === 'ABORT_ERR');
  }
});

test('deadline failures are explicit, stop the child, and do not poison later searches', async () => {
  const f = fixture();
  try {
    for (const variant of ['legacy', 'structured', 'anchors'] as const) {
      let tool: any;
      const register = (timeoutMs: number) => registerSessionSearchTool({ registerTool: (definition: any) => { tool = definition; } } as any, f.manager, { variant }, { sessionsDir: f.root, timeoutMs });
      const args = variant === 'anchors' ? { markdown: 'any:\n- needle' } : { query: 'needle', include_current_session: true };
      register(1);
      await assert.rejects(tool.execute('deadline', args), (error: any) => error.name === 'SessionSearchTimeoutError' && error.code === 'SESSION_SEARCH_TIMEOUT');
      register(10_000);
      const result = await tool.execute('after-deadline', args);
      assert.equal(result.details.success, true);
      assert.ok(result.details.count > 0);
    }
  } finally { f.cleanup(); }
});

test('child-side evidence availability errors retain the public error contract', async () => {
  const f = fixture();
  try {
    f.manager.getDb().prepare('UPDATE extension_metadata SET value=? WHERE key=?').run(JSON.stringify({ status: 'repairing' }), 'session_repair_state:v1');
    const parentWithoutGate = { getPath: () => f.manager.getPath(), assertSessionEvidenceAvailable() { assert.fail('search accessed the managed gate in the parent'); } };
    for (const variant of ['legacy', 'structured'] as const) {
      let tool: any;
      registerSessionSearchTool({ registerTool: (definition: any) => { tool = definition; } } as any, parentWithoutGate as any, { variant }, { sessionsDir: f.root });
      const result = await tool.execute('unavailable', { query: 'needle' });
      assert.deepEqual(result.details, { success: false, error: 'session_evidence_unavailable' });
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, JSON.stringify(result.details));
    }
  } finally { f.cleanup(); }
});

test('the deadline terminates a native SQLite statement after startup has completed', async () => {
  const f = fixture();
  let tool: any;
  slowNativeStatement(f.manager);
  registerSessionSearchTool({ registerTool: (definition: any) => { tool = definition; } } as any, f.manager, { variant: 'legacy' }, { sessionsDir: f.root, timeoutMs: 800 });
  let progressAt = 0;
  const started = performance.now();
  try {
    await assert.rejects(tool.execute('native-deadline', { query: 'needle' }, undefined, () => { progressAt = performance.now(); }), (error: any) => error.name === 'SessionSearchTimeoutError');
    assert.ok(progressAt > 0 && performance.now() - progressAt >= 100, 'deadline only exercised startup');
    assert.ok(performance.now() - started < 1_500, 'deadline waited for the native SQLite statement');
  } finally { f.cleanup(); }
});

test('a first indexed search stays responsive under a SQLite lock and respects its deadline', async () => {
  const f = lockedColdManager();
  try {
    for (const variant of ['legacy', 'structured'] as const) {
      let tool: any;
      registerSessionSearchTool({ registerTool: (definition: any) => { tool = definition; } } as any, f.manager, { variant }, { sessionsDir: f.root, timeoutMs: 150 });
      let ticks = 0;
      const timer = setInterval(() => { ticks++; }, 1);
      const started = performance.now();
      try {
        await assert.rejects(tool.execute('cold-deadline', { query: 'needle' }), (error: any) =>
          error.code === 'SESSION_SEARCH_TIMEOUT' || ('Bun' in globalThis && error.code === 'SQLITE_BUSY'));
        assert.ok(performance.now() - started < 1_000, 'the managed gate escaped the search deadline');
        assert.ok(ticks > 0, 'the managed gate blocked the parent event loop');
      } finally { clearInterval(timer); }
    }
  } finally { f.cleanup(); }
});

test('cancellation reaches a first indexed search while the database is locked', async () => {
  const f = lockedColdManager();
  try {
    for (const variant of ['legacy', 'structured'] as const) {
      let tool: any;
      registerSessionSearchTool({ registerTool: (definition: any) => { tool = definition; } } as any, f.manager, { variant }, { sessionsDir: f.root });
      const controller = new AbortController();
      const started = performance.now();
      const pending = tool.execute('cold-cancel', { query: 'needle' }, controller.signal);
      const timer = setTimeout(() => controller.abort(), 0);
      try {
        await assert.rejects(pending, (error: any) => error.name === 'AbortError' && error.code === 'ABORT_ERR');
        assert.ok(performance.now() - started < 1_000, 'cancellation waited for the managed gate');
      } finally { clearTimeout(timer); }
    }
  } finally { f.cleanup(); }
});

test('a first search preserves empty-index responses without creating a managed database', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-no-index-'));
  const manager = new DatabaseManager(root);
  try {
    for (const variant of ['legacy', 'structured'] as const) {
      let tool: any;
      registerSessionSearchTool({ registerTool: (definition: any) => { tool = definition; } } as any, manager, { variant }, { sessionsDir: root });
      const result = await tool.execute('no-index', { query: 'needle' });
      if (variant === 'legacy') {
        assert.equal(result.details.success, false);
        assert.match(result.content[0].text, /No sessions indexed yet/);
      } else {
        assert.equal(result.details.success, true);
        assert.equal(result.details.count, 0);
        assert.equal(result.content[0].text, 'No results found.');
      }
      assert.equal(fs.existsSync(manager.getPath()), false, 'search initialized the database');
    }
  } finally { manager.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('readonly search refuses unknown repair state in warm and cold managers without writes', async () => {
  const cases = [
    { value: undefined, available: false },
    { value: '{invalid-json', available: false },
    { value: 'null', available: false },
    { value: JSON.stringify({ status: 'complete' }), available: false },
    { value: JSON.stringify({ version: 2, status: 'complete' }), available: false },
    { value: JSON.stringify({ version: 1, status: 'unexpected' }), available: false },
    ...['pending', 'running', 'aborted'].map(status => ({ value: JSON.stringify({ version: 1, status }), available: false })),
    { value: JSON.stringify({ version: 1, status: 'complete' }), available: false, schemaVersion: 0 },
    { value: JSON.stringify({ version: 1, status: 'complete' }), available: true },
  ];
  for (const cold of [false, true]) {
    for (const state of cases) {
      const f = fixture(0);
      try {
        const db = f.manager.getDb();
        if (state.value === undefined) db.prepare('DELETE FROM extension_metadata WHERE key=?').run('session_repair_state:v1');
        else db.prepare('UPDATE extension_metadata SET value=? WHERE key=?').run(state.value, 'session_repair_state:v1');
        if ('schemaVersion' in state) db.exec(`PRAGMA user_version = ${state.schemaVersion}`);
        if (cold) f.manager.close();
        const before = fs.readFileSync(f.manager.getPath());
        const beforeWal = fs.existsSync(`${f.manager.getPath()}-wal`) ? fs.readFileSync(`${f.manager.getPath()}-wal`) : Buffer.alloc(0);
        f.manager.getDb = () => { assert.fail('search opened the managed connection'); };
        f.manager.assertSessionEvidenceAvailable = () => { assert.fail('search used the managed gate'); };
        for (const variant of ['legacy', 'structured'] as const) {
          let tool: any;
          registerSessionSearchTool({ registerTool: (definition: any) => { tool = definition; } } as any, f.manager, { variant }, { sessionsDir: f.root });
          const result = await tool.execute('repair-state', { query: 'needle' });
          if (state.available) assert.equal(result.details.count, 1);
          else assert.deepEqual(result.details, { success: false, error: 'session_evidence_unavailable' });
        }
        assert.deepEqual(fs.readFileSync(f.manager.getPath()), before, 'search changed the database');
        const afterWal = fs.existsSync(`${f.manager.getPath()}-wal`) ? fs.readFileSync(`${f.manager.getPath()}-wal`) : Buffer.alloc(0);
        assert.deepEqual(afterWal, beforeWal, 'search changed the WAL');
      } finally { f.cleanup(); }
    }
  }
});

for (const metadataStore of [
  { name: 'missing table', sql: '' },
  { name: 'missing key column', sql: 'CREATE TABLE extension_metadata (value TEXT)' },
  { name: 'missing value column', sql: 'CREATE TABLE extension_metadata (key TEXT)' },
]) {
  test(`readonly search returns unavailable for ${metadataStore.name} without repairing warm or cold databases`, async () => {
    for (const cold of [false, true]) {
      const f = fixture(0);
      try {
        const db = f.manager.getDb();
        db.exec('DROP TABLE extension_metadata');
        if (metadataStore.sql) db.exec(metadataStore.sql);
        if (cold) f.manager.close();
        const before = fs.readFileSync(f.manager.getPath());
        const walPath = `${f.manager.getPath()}-wal`;
        const beforeWal = fs.existsSync(walPath) ? fs.readFileSync(walPath) : Buffer.alloc(0);
        f.manager.getDb = () => { assert.fail('search opened the managed connection'); };
        f.manager.assertSessionEvidenceAvailable = () => { assert.fail('search used the managed gate'); };
        for (const variant of ['legacy', 'structured'] as const) {
          let tool: any;
          registerSessionSearchTool({ registerTool: (definition: any) => { tool = definition; } } as any, f.manager, { variant }, { sessionsDir: f.root });
          const result = await tool.execute('missing-metadata-store', { query: 'needle' });
          assert.deepEqual(result.details, { success: false, error: 'session_evidence_unavailable' });
          assert.equal(result.content[0].text, JSON.stringify(result.details));
          assert.deepEqual(fs.readFileSync(f.manager.getPath()), before, 'search changed the database');
          const afterWal = fs.existsSync(walPath) ? fs.readFileSync(walPath) : Buffer.alloc(0);
          assert.deepEqual(afterWal, beforeWal, 'search changed the WAL');
        }
      } finally { f.cleanup(); }
    }
  });
}

test('repair metadata columns retain SQLite case-insensitive identifier semantics', async () => {
  for (const cold of [false, true]) {
    const f = fixture(0);
    try {
      const db = f.manager.getDb();
      db.exec('ALTER TABLE extension_metadata RENAME COLUMN key TO Key');
      f.manager.assertSessionEvidenceAvailable();
      if (cold) f.manager.close();
      const before = fs.readFileSync(f.manager.getPath());
      const walPath = `${f.manager.getPath()}-wal`;
      const beforeWal = fs.existsSync(walPath) ? fs.readFileSync(walPath) : Buffer.alloc(0);
      f.manager.getDb = () => { assert.fail('search opened the managed connection'); };
      f.manager.assertSessionEvidenceAvailable = () => { assert.fail('search used the managed gate'); };
      for (const variant of ['legacy', 'structured'] as const) {
        let tool: any;
        registerSessionSearchTool({ registerTool: (definition: any) => { tool = definition; } } as any, f.manager, { variant }, { sessionsDir: f.root });
        const result = await tool.execute('case-insensitive-metadata', { query: 'needle' });
        assert.equal(result.details.count, 1);
        assert.deepEqual(fs.readFileSync(f.manager.getPath()), before, 'search changed the database');
        assert.deepEqual(fs.existsSync(walPath) ? fs.readFileSync(walPath) : Buffer.alloc(0), beforeWal, 'search changed the WAL');
      }
    } finally { f.cleanup(); }
  }
});

test('oversized anchors fail explicitly in the child and do not poison later requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-anchor-budget-'));
  const file = path.join(root, 'session.jsonl');
  const term = 'needle'.repeat(2_000);
  const rows = [JSON.stringify({ type: 'session', id: 'anchor-budget', cwd: '/work/budget' })];
  for (let i = 0; i < 100; i++) {
    rows.push(JSON.stringify({ type: 'message', id: `hit-${i}`, message: { role: 'user', content: term } }));
    rows.push(JSON.stringify({ type: 'custom', data: 'unmatched' }));
  }
  fs.writeFileSync(file, rows.join('\n') + '\n');
  let tool: any;
  const unopened = { getPath() { assert.fail('anchors accessed the indexed DB'); } };
  registerSessionSearchTool({ registerTool: (definition: any) => { tool = definition; } } as any, unopened as any, { variant: 'anchors' }, { sessionsDir: root });
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  try {
    await assert.rejects(tool.execute('large-anchor', { markdown: `limit: 100\nany:\n- ${term}` }), (error: any) => error.code === 'SESSION_SEARCH_RESPONSE_LIMIT' && /1 MiB.*narrow/i.test(error.message));
    assert.ok(ticks > 0, 'the oversized response blocked the parent');
    await assert.rejects(tool.execute('large-invalid-markdown', { markdown: 'x'.repeat(600_000) }), (error: any) => error.code === 'SESSION_SEARCH_RESPONSE_LIMIT');
    const result = await tool.execute('after-large-anchor', { markdown: 'limit: 100\nany:\n- needle' });
    assert.equal(result.details.count, 100);
    assert.ok(result.details.ranges.every((range: any, i: number) => range.path === file && range.startLine === 2 + i * 2 && range.endLine === range.startLine));
    assert.ok(Buffer.byteLength(JSON.stringify({ type: 'result', ok: true, result }), 'utf8') <= 1024 * 1024);
  } finally { clearInterval(timer); fs.rmSync(root, { recursive: true, force: true }); }
});
