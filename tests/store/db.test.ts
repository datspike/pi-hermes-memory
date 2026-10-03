import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { DatabaseManager, SQLITE_BUSY_TIMEOUT_MS, SQLITE_WAL_AUTOCHECKPOINT_PAGES } from '../../src/store/db.js';
import { AtomicLockCoordinator } from '../../src/store/atomic-lock-coordinator.js';

describe('DatabaseManager', () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-'));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function assertQuickCheckOk(db: InstanceType<typeof Database>): void {
    const rows = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    assert.deepStrictEqual(rows.map((row) => Object.values(row)[0]), ['ok']);
  }

  function corruptSqliteError(): Error & { code: string } {
    const err = new Error('SQLITE_CORRUPT: database disk image is malformed') as Error & { code: string };
    err.code = 'SQLITE_CORRUPT';
    return err;
  }

  function corruptRecoverableIndexPage(dbPath: string, indexName: string): void {
    const db = new Database(dbPath);
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    const row = db.prepare(`
      SELECT pageno
      FROM dbstat
      WHERE name = ? AND pagetype IN ('internal', 'leaf')
      ORDER BY pageno ASC
      LIMIT 1
    `).get(indexName) as { pageno: number } | undefined;
    db.close();

    assert.ok(row, `dbstat did not find index page for ${indexName}`);
    assert.ok(row.pageno > 1, 'will not corrupt sqlite database header page');

    const buffer = fs.readFileSync(dbPath);
    const offset = (row.pageno - 1) * pageSize;
    for (let i = 0; i < 16 && offset + i < buffer.length; i++) {
      buffer[offset + i] ^= 0xff;
    }
    fs.writeFileSync(dbPath, buffer);

    const checkDb = new Database(dbPath);
    try {
      const rows = checkDb.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
      const ok = rows.length === 1 && Object.values(rows[0])[0] === 'ok';
      assert.equal(ok, false, 'test fixture must produce a quick_check failure');
      assert.doesNotThrow(() => {
        checkDb.prepare('SELECT COUNT(*) as count FROM sessions NOT INDEXED').get();
        checkDb.prepare('SELECT COUNT(*) as count FROM messages NOT INDEXED').get();
        checkDb.prepare('SELECT COUNT(*) as count FROM memories NOT INDEXED').get();
      }, 'test fixture must leave core table scans readable');
    } finally {
      checkDb.close();
    }
  }

  describe('initialization', () => {
    it('supports valid multi-statement exec scripts without replaying them', () => {
      const db = dbManager.getDb();
      assert.doesNotThrow(() => db.exec('CREATE TABLE script_fixture (value TEXT); INSERT INTO script_fixture VALUES (\'ok\');'));
      assert.deepStrictEqual(db.prepare('SELECT value FROM script_fixture').get(), { value: 'ok' });
    });

    it('fails closed when only WAL sidecars remain without the canonical database', () => {
      const db = dbManager.getDb();
      db.prepare('CREATE TABLE sidecar_state (value TEXT)').run();
      db.prepare('INSERT INTO sidecar_state VALUES (?)').run('kept');
      dbManager.close();
      const dbPath = path.join(tmpDir, 'sessions.db');
      fs.writeFileSync(`${dbPath}-wal`, 'sidecar-only');
      fs.writeFileSync(`${dbPath}-shm`, 'sidecar-only');
      fs.rmSync(dbPath);
      assert.throws(() => new DatabaseManager(tmpDir).getDb(), /sidecar|canonical|main file|temporarily absent/i);
      assert.equal(fs.existsSync(dbPath), false);
    });

    it('should create database file on first getDb() call', () => {
      assert.strictEqual(dbManager.exists(), false);
      const db = dbManager.getDb();
      assert.ok(db);
      assert.strictEqual(dbManager.exists(), true);
    });

    it('should create sessions.db in the specified directory', () => {
      dbManager.getDb();
      const expectedPath = path.join(tmpDir, 'sessions.db');
      assert.strictEqual(dbManager.getPath(), expectedPath);
      assert.ok(fs.existsSync(expectedPath));
    });

    it('should return same db instance on multiple getDb() calls', () => {
      const db1 = dbManager.getDb();
      const db2 = dbManager.getDb();
      assert.strictEqual(db1, db2);
    });

    it('waits for a concurrent writer instead of failing immediately', async () => {
      const db = dbManager.getDb();
      const child = spawn(process.execPath, [
        '-e',
        `const Database = require('better-sqlite3');
         const db = new Database(process.argv[1]);
         db.exec('BEGIN IMMEDIATE');
         process.stdout.write('locked');
         setTimeout(() => { db.exec('COMMIT'); db.close(); }, 100);`,
        path.join(tmpDir, 'sessions.db'),
      ], { stdio: ['ignore', 'pipe', 'inherit'] });

      const childExit = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code));
      });
      const childReady = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('child did not lock database in time')), 5000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`child exited before locking database (code ${code})`));
        });
        child.stdout?.once('data', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      await childReady;
      db.prepare(`
        INSERT INTO extension_metadata (key, value)
        VALUES ('concurrent-writer', 'waited')
      `).run();
      await childExit;

      const timeout = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
      assert.strictEqual(timeout.timeout, SQLITE_BUSY_TIMEOUT_MS);
    });

    it('should create parent directory if it does not exist', () => {
      const nestedDir = path.join(tmpDir, 'nested', 'dir');
      const manager = new DatabaseManager(nestedDir);
      manager.getDb();
      assert.ok(fs.existsSync(path.join(nestedDir, 'sessions.db')));
      manager.close();
    });

    it('defers database creation while an initialization guard is active', () => {
      const guardedDir = path.join(tmpDir, 'guarded');
      const manager = new DatabaseManager(guardedDir);
      manager.setOpenGuard(() => {
        throw new Error('legacy database migration pending');
      });

      assert.throws(() => manager.getDb(), /legacy database migration pending/);
      assert.equal(fs.existsSync(path.join(guardedDir, 'sessions.db')), false);

      manager.setOpenGuard(null);
      assert.ok(manager.getDb());
      assert.equal(fs.existsSync(path.join(guardedDir, 'sessions.db')), true);
      manager.close();
    });
  });

  describe('schema', () => {
    it('should create all required tables', () => {
      const db = dbManager.getDb();
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
      `).all() as { name: string }[];

      const tableNames = tables.map(t => t.name);
      assert.ok(tableNames.includes('sessions'), 'sessions table missing');
      assert.ok(tableNames.includes('messages'), 'messages table missing');
      assert.ok(tableNames.includes('memories'), 'memories table missing');
    });

    it('should create FTS5 virtual tables', () => {
      const db = dbManager.getDb();
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%'
      `).all() as { name: string }[];

      const tableNames = tables.map(t => t.name);
      assert.ok(tableNames.includes('message_fts'), 'message_fts table missing');
      assert.ok(tableNames.includes('memory_fts'), 'memory_fts table missing');
    });
    it('migrates existing unicode61 FTS in resumable chunks and preserves indexed data', async () => {
      const db = dbManager.getDb();
      db.prepare(`
        INSERT INTO sessions (id, project, cwd, started_at)
        VALUES (?, ?, ?, ?)
      `).run('cjk-session', 'test-project', '/tmp/test-project', '2026-05-03T00:00:00Z');
      db.prepare(`
        INSERT INTO messages (id, session_id, role, content, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        'cjk-message',
        'cjk-session',
        'assistant',
        '设备清单包含 NAS',
        '2026-05-03T00:01:00Z',
      );
      db.prepare(`
        INSERT INTO memories (project, target, content, created, last_referenced)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        'test-project',
        'memory',
        '设备清单包含 NAS',
        '2026-05-03',
        '2026-05-03',
      );

      db.exec(`
        DROP TABLE message_fts;
        DROP TABLE memory_fts;
        CREATE VIRTUAL TABLE message_fts USING fts5(
          content,
          content='messages',
          content_rowid='rowid'
        );
        CREATE VIRTUAL TABLE memory_fts USING fts5(
          content,
          content='memories',
          content_rowid='id'
        );
        INSERT INTO message_fts(message_fts) VALUES ('rebuild');
        INSERT INTO memory_fts(memory_fts) VALUES ('rebuild');
        DELETE FROM extension_metadata WHERE key = 'fts5_tokenizer_version';
      `);
      dbManager.close();

      dbManager = new DatabaseManager(tmpDir);
      const migrated = dbManager.getDb();
      assert.equal(dbManager.getSessionRepairState()?.status, 'pending');
      for (let step = 0; step < 30 && dbManager.getSessionRepairState()?.status !== 'complete'; step++) {
        await dbManager.runSessionRepairChunk({ chunkSize: 2 });
      }
      assert.equal(dbManager.getSessionRepairState()?.status, 'complete');
      const tableSql = migrated.prepare(`
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'table' AND name IN ('message_fts', 'memory_fts')
        ORDER BY name
      `).all() as Array<{ name: string; sql: string }>;

      assert.strictEqual(tableSql.length, 2);
      assert.ok(tableSql.every((table) => table.sql.includes("tokenize='trigram'")));
      assert.deepStrictEqual(
        migrated.prepare('SELECT value FROM extension_metadata WHERE key = ?').get('fts5_tokenizer_version'),
        { value: 'trigram-v1' },
      );
      assert.ok(
        migrated.prepare('SELECT rowid FROM message_fts WHERE message_fts MATCH ?').all('设备清单').length > 0,
      );
      assert.ok(
        migrated.prepare('SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?').all('设备清单').length > 0,
      );
    });

    it('does no tokenizer work on open once both indexes and the repair marker are complete', () => {
      const db = dbManager.getDb();
      const stateBefore = dbManager.getSessionRepairState();
      const sqlBefore = db.prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('message_fts', 'memory_fts') ORDER BY name").all();
      dbManager.close();
      dbManager = new DatabaseManager(tmpDir);
      const reopened = dbManager.getDb();
      assert.deepEqual(dbManager.getSessionRepairState(), stateBefore);
      assert.deepEqual(reopened.prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('message_fts', 'memory_fts') ORDER BY name").all(), sqlBefore);
      assert.deepEqual(reopened.prepare('SELECT value FROM extension_metadata WHERE key = ?').get('fts5_tokenizer_version'), { value: 'trigram-v1' });
    });

    it('queues tokenizer migration even when a stale version marker remains', () => {
      const db = dbManager.getDb();
      db.exec(`DROP TABLE message_fts; CREATE VIRTUAL TABLE message_fts USING fts5(content, content='messages', content_rowid='rowid');`);
      dbManager.close();
      dbManager = new DatabaseManager(tmpDir);
      const reopened = dbManager.getDb();
      assert.equal(dbManager.getSessionRepairState()?.status, 'pending');
      assert.equal(dbManager.getSessionRepairState()?.phase, 'message_fts');
      assert.equal(reopened.prepare('SELECT value FROM extension_metadata WHERE key = ?').get('fts5_tokenizer_version'), undefined);
      assert.throws(() => dbManager.assertSessionEvidenceAvailable(), /migration is incomplete/i);
    });


    it('should create triggers for FTS sync', () => {
      const db = dbManager.getDb();
      const triggers = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='trigger'
      `).all() as { name: string }[];

      const triggerNames = triggers.map(t => t.name);
      assert.ok(triggerNames.includes('messages_ai'), 'messages_ai trigger missing');
      assert.ok(triggerNames.includes('messages_ad'), 'messages_ad trigger missing');
      assert.ok(triggerNames.includes('messages_au'), 'messages_au trigger missing');
      assert.ok(triggerNames.includes('memories_ai'), 'memories_ai trigger missing');
      assert.ok(triggerNames.includes('memories_ad'), 'memories_ad trigger missing');
      assert.ok(triggerNames.includes('memories_au'), 'memories_au trigger missing');
    });

    it('should be idempotent — running schema twice does not error', () => {
      const db = dbManager.getDb();
      // The schema uses IF NOT EXISTS, so running it again should be safe
      assert.doesNotThrow(() => {
        dbManager.close();
        dbManager = new DatabaseManager(tmpDir);
        dbManager.getDb();
      });
    });

    it('should migrate legacy memories table without category column', () => {
      const dbPath = path.join(tmpDir, 'sessions.db');
      const legacyDb = new Database(dbPath);

      legacyDb.exec(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT,
          target TEXT NOT NULL CHECK (target IN ('memory', 'user')),
          content TEXT NOT NULL,
          created DATE NOT NULL,
          last_referenced DATE NOT NULL
        );
      `);
      legacyDb.close();

      const migratedManager = new DatabaseManager(tmpDir);
      const migratedDb = migratedManager.getDb();
      const columns = migratedDb.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
      const names = columns.map((c) => c.name);

      assert.ok(names.includes('category'));
      assert.ok(names.includes('failure_reason'));
      assert.ok(names.includes('tool_state'));
      assert.ok(names.includes('corrected_to'));

      migratedManager.close();
    });

    it('should migrate legacy sessions table without project column', () => {
      const dbPath = path.join(tmpDir, 'sessions.db');
      const legacyDb = new Database(dbPath);

      legacyDb.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          message_count INTEGER DEFAULT 0
        );
      `);
      legacyDb.prepare(`
        INSERT INTO sessions (id, cwd, started_at)
        VALUES (?, ?, ?)
      `).run('legacy-session', '/work/my-app', '2026-05-03T00:00:00Z');
      legacyDb.close();

      const migratedManager = new DatabaseManager(tmpDir);
      const migratedDb = migratedManager.getDb();
      const columns = migratedDb.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
      const names = columns.map((c) => c.name);

      assert.ok(names.includes('project'));

      const row = migratedDb.prepare('SELECT project FROM sessions WHERE id = ?').get('legacy-session') as { project: string };
      assert.strictEqual(row.project, 'my-app');

      assert.doesNotThrow(() => {
        migratedDb.prepare(`
          INSERT INTO sessions (id, project, cwd, started_at)
          VALUES (?, ?, ?, ?)
        `).run('new-session', 'new-project', '/work/new-project', '2026-05-04T00:00:00Z');
      });

      migratedManager.close();
    });

    it('does not use an unbounded sessions count during schema initialization', () => {
      const db = dbManager.getDb();
      const plan = db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM sessions LIMIT 1').all() as Array<{ detail: string }>;
      assert.ok(plan.every((row) => !/COUNT\s*\(/i.test(row.detail)));
      assert.equal((db.prepare('SELECT 1 FROM sessions LIMIT 1').get() as { 1: number } | undefined), undefined);
    });

    it('should migrate legacy memories table without project column', () => {
      const dbPath = path.join(tmpDir, 'sessions.db');
      const legacyDb = new Database(dbPath);

      legacyDb.exec(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          target TEXT NOT NULL CHECK (target IN ('memory', 'user')),
          content TEXT NOT NULL,
          created DATE NOT NULL,
          last_referenced DATE NOT NULL
        );
      `);
      legacyDb.prepare(`
        INSERT INTO memories (target, content, created, last_referenced)
        VALUES (?, ?, ?, ?)
      `).run('memory', 'legacy memory entry', '2026-05-09', '2026-05-09');
      legacyDb.close();

      const migratedManager = new DatabaseManager(tmpDir);
      const migratedDb = migratedManager.getDb();
      const columns = migratedDb.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
      const names = columns.map((c) => c.name);

      assert.ok(names.includes('project'));

      const row = migratedDb.prepare('SELECT project, content FROM memories').get() as {
        project: string | null;
        content: string;
      };
      assert.strictEqual(row.project, null);
      assert.strictEqual(row.content, 'legacy memory entry');

      migratedManager.close();
    });

    it('should migrate legacy target CHECK constraint to allow failure entries', () => {
      const dbPath = path.join(tmpDir, 'sessions.db');
      const legacyDb = new Database(dbPath);

      legacyDb.exec(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT,
          target TEXT NOT NULL CHECK (target IN ('memory', 'user')),
          category TEXT,
          content TEXT NOT NULL,
          failure_reason TEXT,
          tool_state TEXT,
          corrected_to TEXT,
          created DATE NOT NULL,
          last_referenced DATE NOT NULL
        );
      `);
      legacyDb.prepare(`
        INSERT INTO memories (project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(null, 'memory', null, 'existing memory', null, null, null, '2026-05-09', '2026-05-09');
      legacyDb.close();

      const migratedManager = new DatabaseManager(tmpDir);
      const migratedDb = migratedManager.getDb();

      assert.doesNotThrow(() => {
        migratedDb.prepare(`
          INSERT INTO memories (project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(null, 'failure', 'failure', 'failed setup', 'legacy check fixed', null, null, '2026-05-09', '2026-05-09');
      });

      const rows = migratedDb.prepare(`SELECT target, content FROM memories ORDER BY id ASC`).all() as Array<{ target: string; content: string }>;
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].content, 'existing memory');
      assert.strictEqual(rows[1].target, 'failure');

      const indexes = migratedDb.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name IN ('idx_memories_project', 'idx_memories_target', 'idx_memories_category')
      `).all() as Array<{ name: string }>;
      assert.deepStrictEqual(
        indexes.map((row) => row.name).sort(),
        ['idx_memories_category', 'idx_memories_project', 'idx_memories_target'],
      );

      migratedManager.close();
    });
  });

  describe('publication journal recovery', () => {
    it('fails closed on a tampered journal path without moving artifacts', () => {
      dbManager.getDb();
      dbManager.close();
      const dbPath = path.join(tmpDir, 'sessions.db');
      const journalPath = `${dbPath}.publication-state.json`;
      const backupBase = `${dbPath}.corrupt-test-${process.pid}`;
      fs.writeFileSync(journalPath, JSON.stringify({
        version: 1,
        canonicalPath: dbPath,
        recoveryToken: 'owner-token',
        phase: 'temp-verified',
        tempPath: path.join(tmpDir, '..', 'outside.tmp'),
        backupBase,
        plannedSuffixes: [''],
        movedSuffixes: [],
      }), { mode: 0o600 });
      const before = fs.readFileSync(dbPath);
      assert.throws(() => new DatabaseManager(tmpDir).getDb(), /publication journal.*invalid/i);
      assert.deepEqual(fs.readFileSync(dbPath), before);
      assert.equal(fs.existsSync(backupBase), false);
      assert.equal(fs.existsSync(journalPath), true);
    });

    it('reconciles a dead publication journal and preserves each source row once', () => {
      const db = dbManager.getDb();
      db.prepare('INSERT INTO sessions (id, project, cwd, started_at) VALUES (?, ?, ?, ?)')
        .run('journal-session', 'project', '/tmp/project', '2026-08-09T00:00:00Z');
      db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run('journal-message', 'journal-session', 'user', 'journal row', '2026-08-09T00:01:00Z');
      dbManager.close();
      const dbPath = path.join(tmpDir, 'sessions.db');
      const tempPath = `${dbPath}.rebuild-fixture-${process.pid}.tmp`;
      const backupBase = `${dbPath}.corrupt-fixture-${process.pid}`;
      fs.copyFileSync(dbPath, tempPath);
      fs.writeFileSync(`${dbPath}.publication-state.json`, JSON.stringify({
        version: 1,
        canonicalPath: dbPath,
        recoveryToken: 'old-recovery-token',
        phase: 'temp-verified',
        tempPath,
        backupBase,
        plannedSuffixes: [''],
        movedSuffixes: [],
      }), { mode: 0o600 });
      const lockDb = new Database(path.join(tmpDir, '.pi-hermes-locks.sqlite'));
      lockDb.prepare('INSERT INTO locks (lock_key, token, pid, incarnation, acquired_at) VALUES (?, ?, ?, ?, ?)')
        .run(`publication:${dbPath}`, 'dead-publication', 999999, null, Date.now());
      lockDb.close();

      dbManager = new DatabaseManager(tmpDir);
      const reopened = dbManager.getDb();
      assert.equal(fs.existsSync(`${dbPath}.publication-state.json`), false);
      assert.equal((reopened.prepare('SELECT COUNT(*) AS count FROM sessions WHERE id = ?').get('journal-session') as { count: number }).count, 1);
      assert.equal((reopened.prepare('SELECT COUNT(*) AS count FROM messages WHERE entry_id = ?').get('journal-message') as { count: number }).count, 1);
    });
  });

  describe('publication crash matrix', () => {
    for (const stage of [
      'after-source-rename',
      'before-canonical-rename',
      'after-published-phase',
      'after-verified-before-release',
      'after-publication-release-before-journal-delete',
    ]) {
      it(`reconciles a deterministic publication interruption at ${stage}`, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-matrix-'));
        let manager = new DatabaseManager(dir);
        try {
          const db = manager.getDb();
          db.prepare('INSERT INTO sessions (id, project, cwd, started_at) VALUES (?, ?, ?, ?)').run('matrix-session', 'project', '/tmp/project', '2026-08-09T00:00:00Z');
          db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)').run('matrix-message', 'matrix-session', 'user', 'matrix row', '2026-08-09T00:01:00Z');
          manager.close();
          corruptRecoverableIndexPage(path.join(dir, 'sessions.db'), 'idx_messages_timestamp');
          manager = new DatabaseManager(dir);
          let interrupted = false;
          (manager as any).publicationFaultHook = (observed: string) => {
            if (!interrupted && observed === stage) {
              interrupted = true;
              throw new Error(`fixture crash at ${stage}`);
            }
          };
          assert.throws(() => manager.recoverFromCorruption(corruptSqliteError()), /fixture crash/);
          assert.equal(fs.existsSync(path.join(dir, 'sessions.db.publication-state.json')), true);
          (manager as any).publicationFaultHook = null;
          manager.close();
          manager = new DatabaseManager(dir);
          const recovered = manager.getDb();
          assert.equal(fs.existsSync(path.join(dir, 'sessions.db.publication-state.json')), false);
          assert.equal((recovered.prepare('SELECT COUNT(*) AS count FROM sessions WHERE id = ?').get('matrix-session') as { count: number }).count, 1);
          assert.equal((recovered.prepare('SELECT COUNT(*) AS count FROM messages WHERE entry_id = ?').get('matrix-message') as { count: number }).count, 1);
        } finally {
          manager.close();
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    }

    it('preserves an incomplete journal and never creates an empty canonical database', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-incomplete-'));
      let manager = new DatabaseManager(dir);
      try {
        manager.getDb();
        manager.close();
        const dbPath = path.join(dir, 'sessions.db');
        const journalPath = `${dbPath}.publication-state.json`;
        fs.writeFileSync(journalPath, JSON.stringify({
          version: 1, canonicalPath: dbPath, recoveryToken: 'old-token', phase: 'quarantine',
          tempPath: `${dbPath}.rebuild-incomplete.tmp`, backupBase: `${dbPath}.corrupt-incomplete`,
          plannedSuffixes: [''], movedSuffixes: [],
        }), { mode: 0o600 });
        const locks = new Database(path.join(dir, '.pi-hermes-locks.sqlite'));
        locks.prepare('INSERT INTO locks (lock_key, token, pid, incarnation, acquired_at) VALUES (?, ?, ?, ?, ?)').run(`publication:${dbPath}`, 'dead-pub', 999999, null, Date.now());
        locks.close();
        manager = new DatabaseManager(dir, { recoveryLockWaitMs: 25, recoveryLockPollMs: 1 });
        assert.throws(() => manager.getDb(), /suffix is missing|insufficient backups|publication/);
        assert.equal(fs.existsSync(journalPath), true);
        assert.equal(fs.statSync(dbPath).size > 0, true);
      } finally {
        manager.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('fails closed on a dead publication row when no journal exists', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-no-journal-'));
      let manager = new DatabaseManager(dir);
      try {
        manager.getDb();
        manager.close();
        const dbPath = path.join(dir, 'sessions.db');
        const locks = new Database(path.join(dir, '.pi-hermes-locks.sqlite'));
        locks.prepare('INSERT INTO locks (lock_key, token, pid, incarnation, acquired_at) VALUES (?, ?, ?, ?, ?)').run(`publication:${dbPath}`, 'dead-pub', 999999, null, Date.now());
        locks.close();
        manager = new DatabaseManager(dir, { recoveryLockWaitMs: 10, recoveryLockPollMs: 1 });
        assert.throws(() => manager.getDb(), /unverifiable publication|publication/);
        assert.throws(() => manager.recoverFromCorruption(corruptSqliteError()), /timed out|publication/);
        assert.equal(fs.existsSync(`${dbPath}.publication-state.json`), false);
      } finally {
        manager.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('restores a complete planned backup set when candidate and canonical are missing', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-restore-'));
      let manager = new DatabaseManager(dir);
      try {
        const db = manager.getDb();
        db.prepare('INSERT INTO sessions (id, project, cwd, started_at) VALUES (?, ?, ?, ?)').run('restore-session', 'project', '/tmp/project', '2026-08-09T00:00:00Z');
        manager.close();
        const dbPath = path.join(dir, 'sessions.db');
        const tempPath = `${dbPath}.rebuild-restore.tmp`;
        const backupBase = `${dbPath}.corrupt-restore`;
        fs.renameSync(dbPath, backupBase);
        fs.writeFileSync(`${dbPath}.publication-state.json`, JSON.stringify({
          version: 1, canonicalPath: dbPath, recoveryToken: 'old-token', phase: 'quarantine',
          tempPath, backupBase, plannedSuffixes: [''], movedSuffixes: [],
        }), { mode: 0o600 });
        const locks = new Database(path.join(dir, '.pi-hermes-locks.sqlite'));
        locks.prepare('INSERT INTO locks (lock_key, token, pid, incarnation, acquired_at) VALUES (?, ?, ?, ?, ?)').run(`publication:${dbPath}`, 'dead-pub', 999999, null, Date.now());
        locks.close();
        manager = new DatabaseManager(dir);
        const restored = manager.getDb();
        assert.equal((restored.prepare('SELECT COUNT(*) AS count FROM sessions WHERE id=?').get('restore-session') as { count: number }).count, 1);
        assert.equal(fs.existsSync(`${dbPath}.publication-state.json`), false);
      } finally {
        manager.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns deterministic moved backup paths after successful publication', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-backups-'));
      try {
        dbManager.getDb();
        dbManager.close();
        fs.writeFileSync(path.join(dir, 'sessions.db'), 'not a sqlite database');
        const recoveryManager = new DatabaseManager(dir);
        const result = recoveryManager.recoverFromCorruption(corruptSqliteError());
        assert.ok(result.backupPaths.length >= 1);
        assert.ok(result.backupPaths.every((backup) => fs.existsSync(backup)));
        recoveryManager.close();
      } finally {
        dbManager.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('corruption recovery', () => {
    it('waits for a recovery owner and reuses the healthy database it leaves behind', () => {
      dbManager.getDb();
      dbManager.close();
      const canonicalDbPath = fs.realpathSync(path.join(tmpDir, 'sessions.db'));
      const lockDbPath = path.join(path.dirname(canonicalDbPath), '.pi-hermes-locks.sqlite');
      const lockKey = `recovery:${canonicalDbPath}`;
      const coordinator = new AtomicLockCoordinator(lockDbPath);
      const lease = coordinator.tryAcquire(lockKey, { staleMs: 10_000 });
      assert.ok(lease);
      spawn(process.execPath, [
        '-e',
        `setTimeout(() => {
          const Database = require('better-sqlite3');
          const db = new Database(process.argv[1]);
          db.prepare('DELETE FROM locks WHERE lock_key = ? AND token = ?').run(process.argv[2], process.argv[3]);
          db.close();
        }, 100)`,
        lockDbPath,
        lockKey,
        lease.token,
      ], { stdio: 'ignore' });

      dbManager = new DatabaseManager(tmpDir, { recoveryLockWaitMs: 1000, recoveryLockPollMs: 10, recoveryLockStaleMs: 10_000 });
      const started = Date.now();
      const result = dbManager.recoverFromCorruption(corruptSqliteError());

      assert.strictEqual(result.strategy, 'reused');
      assert.ok(Date.now() - started >= 50, 'peer should wait for the active recovery owner');
      assert.strictEqual(fs.readdirSync(tmpDir).filter((name) => name.startsWith('sessions.db.corrupt-')).length, 0);
    });

    it('takes over a stale recovery lock', () => {
      dbManager.close();
      fs.writeFileSync(path.join(tmpDir, 'sessions.db'), 'not a sqlite database');
      const canonicalDbPath = fs.realpathSync(path.join(tmpDir, 'sessions.db'));
      const lockDbPath = path.join(path.dirname(canonicalDbPath), '.pi-hermes-locks.sqlite');
      const coordinator = new AtomicLockCoordinator(lockDbPath);
      coordinator.tryAcquire('schema-init', { staleMs: 50 })!.release();
      const lockDb = new Database(lockDbPath);
      lockDb.prepare(`
        INSERT INTO locks (lock_key, token, pid, acquired_at)
        VALUES (?, 'dead-owner', 999999, ?)
      `).run(`recovery:${canonicalDbPath}`, Date.now() - 10_000);
      lockDb.close();

      dbManager = new DatabaseManager(tmpDir, { recoveryLockStaleMs: 50 });
      const db = dbManager.getDb();

      assertQuickCheckOk(db as InstanceType<typeof Database>);
    });

    it('aborts destructive recovery rename when the recovery lease was stolen mid-flight', () => {
      dbManager.close();
      fs.writeFileSync(path.join(tmpDir, 'sessions.db'), 'not a sqlite database');
      dbManager = new DatabaseManager(tmpDir, { recoveryLockStaleMs: 60_000 });

      const originalHook = (dbManager as any).publicationFaultHook;
      let hookCalls = 0;
      (dbManager as any).publicationFaultHook = (stage: string) => {
        if (stage === 'before-source-rename') {
          hookCalls++;
          const canonicalDbPath = fs.realpathSync(path.join(tmpDir, 'sessions.db'));
          const lockDbPath = path.join(path.dirname(canonicalDbPath), '.pi-hermes-locks.sqlite');
          const lockKey = `recovery:${canonicalDbPath}`;
          const lockDb = new Database(lockDbPath);
          try { lockDb.prepare('UPDATE locks SET token = ? WHERE lock_key = ?').run('stolen-by-test', lockKey); }
          finally { lockDb.close(); }
        }
      };

      try {
        assert.throws(() => dbManager.getDb(), /SQLite recovery lease lost/);
        assert.strictEqual(hookCalls, 1);
      } finally {
        (dbManager as any).publicationFaultHook = originalHook;
      }
    });

    it('serializes recovery through symlinked database aliases', { skip: process.platform === 'win32' }, () => {
      dbManager.close();
      const realDir = path.join(tmpDir, 'real');
      const aliasDir = path.join(tmpDir, 'alias');
      fs.mkdirSync(realDir);
      fs.symlinkSync(realDir, aliasDir, 'dir');
      fs.writeFileSync(path.join(realDir, 'sessions.db'), 'not a sqlite database');

      const canonicalDbPath = fs.realpathSync(path.join(realDir, 'sessions.db'));
      const coordinator = new AtomicLockCoordinator(path.join(path.dirname(canonicalDbPath), '.pi-hermes-locks.sqlite'));
      const lease = coordinator.tryAcquire(`recovery:${canonicalDbPath}`, { staleMs: 60_000 });
      assert.ok(lease);

      const aliasManager = new DatabaseManager(aliasDir, {
        recoveryLockWaitMs: 25,
        recoveryLockPollMs: 5,
        recoveryLockStaleMs: 60_000,
      });
      try {
        assert.throws(
          () => aliasManager.getDb(),
          /SQLite recovery already in progress/,
        );
      } finally {
        aliasManager.close();
        lease.release();
      }
    });

    it('repairs a file-symlinked database target without replacing the link', { skip: process.platform === 'win32' }, () => {
      dbManager.close();
      const realDir = path.join(tmpDir, 'real');
      const aliasDir = path.join(tmpDir, 'alias');
      fs.mkdirSync(realDir);
      fs.mkdirSync(aliasDir);
      const realDbPath = path.join(realDir, 'sessions.db');
      const aliasDbPath = path.join(aliasDir, 'sessions.db');
      fs.writeFileSync(realDbPath, 'not a sqlite database');
      fs.symlinkSync(realDbPath, aliasDbPath, 'file');

      const aliasManager = new DatabaseManager(aliasDir);
      const aliasDb = aliasManager.getDb();
      aliasDb.prepare("INSERT INTO extension_metadata (key, value) VALUES ('alias-write', 'kept')").run();
      aliasManager.close();

      assert.equal(fs.lstatSync(aliasDbPath).isSymbolicLink(), true);
      const directManager = new DatabaseManager(realDir);
      try {
        const directDb = directManager.getDb();
        assertQuickCheckOk(directDb as InstanceType<typeof Database>);
        assert.deepEqual(
          directDb.prepare("SELECT value FROM extension_metadata WHERE key = 'alias-write'").get(),
          { value: 'kept' },
        );
      } finally {
        directManager.close();
      }
    });

    it('creates and repairs a dangling absolute database symlink through its target', { skip: process.platform === 'win32' }, () => {
      dbManager.close();
      const realDir = path.join(tmpDir, 'real');
      const aliasDir = path.join(tmpDir, 'alias');
      fs.mkdirSync(realDir);
      fs.mkdirSync(aliasDir);
      const realDbPath = path.join(realDir, 'sessions.db');
      const aliasDbPath = path.join(aliasDir, 'sessions.db');
      fs.symlinkSync(realDbPath, aliasDbPath, 'file');

      const aliasManager = new DatabaseManager(aliasDir);
      aliasManager.getDb().prepare(
        "INSERT INTO extension_metadata (key, value) VALUES ('before-corruption', 'kept')",
      ).run();
      aliasManager.close();
      fs.writeFileSync(realDbPath, 'not a sqlite database');

      try {
        assertQuickCheckOk(aliasManager.getDb() as InstanceType<typeof Database>);
      } finally {
        aliasManager.close();
      }
      assert.equal(fs.lstatSync(aliasDbPath).isSymbolicLink(), true);
      const directDb = new Database(realDbPath);
      try {
        assertQuickCheckOk(directDb);
      } finally {
        directDb.close();
      }
    });

    it('rejects database symlink loops before opening SQLite', { skip: process.platform === 'win32' }, () => {
      dbManager.close();
      const loopDir = path.join(tmpDir, 'loop');
      fs.mkdirSync(loopDir);
      fs.symlinkSync('sessions.other', path.join(loopDir, 'sessions.db'), 'file');
      fs.symlinkSync('sessions.db', path.join(loopDir, 'sessions.other'), 'file');

      const manager = new DatabaseManager(loopDir);
      assert.throws(() => manager.getDb(), /symbolic link loop/i);
      manager.close();
    });

    it('cleans abandoned rebuild files and caps corrupt backup sets', () => {
      dbManager.close();
      for (let index = 0; index < 5; index++) {
        fs.writeFileSync(path.join(tmpDir, `sessions.db.corrupt-20260701-${index}`), `backup-${index}`);
      }
      fs.writeFileSync(path.join(tmpDir, 'sessions.db.rebuild-abandoned.tmp'), 'abandoned');
      fs.writeFileSync(path.join(tmpDir, 'sessions.db'), 'not a sqlite database');

      dbManager = new DatabaseManager(tmpDir, { recoveryBackupRetention: 3 });
      dbManager.getDb();

      const names = fs.readdirSync(tmpDir);
      assert.strictEqual(names.some((name) => name.startsWith('sessions.db.rebuild-')), false);
      assert.ok(names.filter((name) => name.startsWith('sessions.db.corrupt-')).length <= 3);
    });

    it('does not count successful recreations toward the recovery circuit', () => {
      dbManager.close();
      const dbPath = path.join(tmpDir, 'sessions.db');
      fs.writeFileSync(dbPath, 'first corrupt database');
      dbManager = new DatabaseManager(tmpDir, {
        recoveryCircuitLimit: 1,
        recoveryCircuitWindowMs: 60_000,
      });
      dbManager.getDb();
      dbManager.close();

      fs.writeFileSync(dbPath, 'second corrupt database');
      dbManager = new DatabaseManager(tmpDir, {
        recoveryCircuitLimit: 1,
        recoveryCircuitWindowMs: 60_000,
      });

      assert.doesNotThrow(() => dbManager.getDb());
      assert.strictEqual(dbManager.getLastRecovery()?.strategy, 'recreated-empty');
    });

    it('keeps verified recovery successful when cleanup state removal fails', () => {
      dbManager.close();
      fs.writeFileSync(path.join(tmpDir, 'sessions.db'), 'corrupt database');
      dbManager = new DatabaseManager(tmpDir);
      let cleanupCalls = 0;
      (dbManager as any).cleanupRecoveryArtifacts = () => {
        cleanupCalls++;
        if (cleanupCalls > 1) throw new Error('injected cleanup failure');
      };
      (dbManager as any).clearRecoveryFailures = () => {
        throw new Error('injected circuit cleanup failure');
      };

      const db = dbManager.getDb();

      assert.ok(db);
      assert.strictEqual(dbManager.getLastRecovery()?.strategy, 'recreated-empty');
      assertQuickCheckOk(db as InstanceType<typeof Database>);
    });

    it('keeps verified recovery successful and clears a failed release before retry', () => {
      const prototype = AtomicLockCoordinator.prototype as any;
      const originalDeleteOwnedLock = prototype.deleteOwnedLock;
      let deleteAttempts = 0;
      prototype.deleteOwnedLock = function (key: string, token: string): void {
        deleteAttempts++;
        if (deleteAttempts <= 2) throw new Error('injected recovery release failure');
        return originalDeleteOwnedLock.call(this, key, token);
      };

      try {
        dbManager.close();
        const dbPath = path.join(tmpDir, 'sessions.db');
        fs.writeFileSync(dbPath, 'first corrupt database');
        dbManager = new DatabaseManager(tmpDir);
        assert.doesNotThrow(() => dbManager.getDb());
        assert.strictEqual(dbManager.getLastRecovery()?.strategy, 'recreated-empty');

        dbManager.close();
        fs.writeFileSync(dbPath, 'second corrupt database');
        dbManager = new DatabaseManager(tmpDir);
        assert.doesNotThrow(() => dbManager.getDb());
        assert.strictEqual(dbManager.getLastRecovery()?.strategy, 'recreated-empty');
        assert.ok(deleteAttempts >= 3);
      } finally {
        prototype.deleteOwnedLock = originalDeleteOwnedLock;
      }
    });

    it('opens the recovery circuit after a failed recovery', () => {
      dbManager.close();
      fs.writeFileSync(path.join(tmpDir, 'sessions.db'), 'corrupt database');
      dbManager = new DatabaseManager(tmpDir, {
        recoveryCircuitLimit: 1,
        recoveryCircuitWindowMs: 60_000,
      });
      let recoveryCalls = 0;
      (dbManager as any).recoverDatabaseFileUnlocked = () => {
        recoveryCalls++;
        throw new Error('injected recovery failure');
      };

      assert.throws(() => dbManager.recoverFromCorruption(corruptSqliteError()), /injected recovery failure/);
      assert.throws(() => dbManager.recoverFromCorruption(corruptSqliteError()), /recovery circuit is open/i);
      assert.strictEqual(recoveryCalls, 1);
    });

    it('counts a failed post-recovery open before clearing the circuit', () => {
      dbManager.close();
      fs.writeFileSync(path.join(tmpDir, 'sessions.db'), 'corrupt database');
      dbManager = new DatabaseManager(tmpDir, {
        recoveryCircuitLimit: 1,
        recoveryCircuitWindowMs: 60_000,
      });
      const originalOpenUnchecked = (dbManager as any).openUnchecked.bind(dbManager);
      let openCalls = 0;
      (dbManager as any).openUnchecked = () => {
        openCalls++;
        if (openCalls === 2) throw new Error('injected post-recovery open failure');
        return originalOpenUnchecked();
      };

      assert.throws(() => dbManager.getDb(), /injected post-recovery open failure/);
      const state = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'sessions.db.recovery-state.json'), 'utf-8'),
      );
      assert.strictEqual(state.failures.length, 1);
    });

    it('does not treat legacy recovery attempt state as failed recoveries', () => {
      dbManager.close();
      fs.writeFileSync(path.join(tmpDir, 'sessions.db'), 'corrupt database');
      fs.writeFileSync(
        path.join(tmpDir, 'sessions.db.recovery-state.json'),
        JSON.stringify({ attempts: [Date.now()] }),
      );
      dbManager = new DatabaseManager(tmpDir, {
        recoveryCircuitLimit: 1,
        recoveryCircuitWindowMs: 60_000,
      });

      assert.doesNotThrow(() => dbManager.getDb());
    });

    it('repairs recoverable corruption on deferred startup scan and preserves readable rows', async () => {
      const db = dbManager.getDb();
      db.prepare(`
        INSERT INTO sessions (id, project, cwd, started_at)
        VALUES (?, ?, ?, ?)
      `).run('recover-session', 'recover-project', '/work/recover', '2026-05-03T00:00:00Z');

      const insertMessage = db.prepare(`
        INSERT INTO messages (id, session_id, role, content, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < 50; i++) {
        insertMessage.run(`recover-msg-${i}`, 'recover-session', i % 2 === 0 ? 'user' : 'assistant', `message ${i}`, `2026-05-03T00:${String(i).padStart(2, '0')}:00Z`);
      }

      db.prepare(`
        INSERT INTO memories (project, target, content, created, last_referenced)
        VALUES (?, ?, ?, ?, ?)
      `).run(null, 'memory', 'recoverable memory', '2026-05-03', '2026-05-03');
      db.prepare('INSERT INTO extension_metadata(key,value) VALUES (?,?)').run('protected_recovery_value', 'retained');
      dbManager.close();

      corruptRecoverableIndexPage(path.join(tmpDir, 'sessions.db'), 'idx_messages_timestamp');

      dbManager = new DatabaseManager(tmpDir);
      assert.doesNotThrow(() => dbManager.getDb());
      await dbManager.waitForStartupIntegrityScan();
      const repairedDb = dbManager.getDb();

      assert.strictEqual(dbManager.getLastRecovery()?.strategy, 'rebuilt');
      assert.deepStrictEqual(dbManager.getLastRecovery()?.recoveredRows, {
        extension_metadata: 2,
        sessions: 1,
        messages: 50,
        session_files: 0,
        memories: 1,
      });
      // The derived tokenizer marker is withheld until coverage is revalidated; unrelated metadata survives.
      assert.strictEqual(repairedDb.prepare('SELECT value FROM extension_metadata WHERE key = ?').get('protected_recovery_value').value, 'retained');
      assert.strictEqual(dbManager.getSessionRepairState()?.status, 'pending');
      assert.deepStrictEqual(dbManager.getStats(), { sessions: 1, messages: 50, memories: 1 });
      const memory = repairedDb.prepare('SELECT content FROM memories WHERE content = ?').get('recoverable memory') as { content: string } | undefined;
      assert.ok(memory);
      assertQuickCheckOk(repairedDb as InstanceType<typeof Database>);
      assert.ok(fs.readdirSync(tmpDir).some((name) => name.startsWith('sessions.db.corrupt-')), 'corrupt DB should be quarantined');
    });

    it('reopened manager runs a fresh integrity scan after close()', async () => {
      const db = dbManager.getDb();
      db.prepare(`
        INSERT INTO sessions (id, project, cwd, started_at)
        VALUES (?, ?, ?, ?)
      `).run('reopen-session', 'reopen-project', '/work/reopen', '2026-05-03T00:00:00Z');
      dbManager.close();

      corruptRecoverableIndexPage(path.join(tmpDir, 'sessions.db'), 'idx_messages_timestamp');

      const reopenedDb = dbManager.getDb();
      await dbManager.waitForStartupIntegrityScan();
      const recoveredDb = dbManager.getDb();

      assert.strictEqual(dbManager.getLastRecovery()?.strategy, 'rebuilt');
      assert.deepStrictEqual(dbManager.getStats(), { sessions: 1, messages: 0, memories: 0 });
      assertQuickCheckOk(recoveredDb as InstanceType<typeof Database>);
      assert.ok(fs.readdirSync(tmpDir).some((name) => name.startsWith('sessions.db.corrupt-')), 'corrupt DB should be quarantined');
    });

    it('skips the startup integrity scan when disabled while preserving normal reads and writes', async () => {
      const db = dbManager.getDb();
      db.prepare(`
        INSERT INTO sessions (id, project, cwd, started_at)
        VALUES (?, ?, ?, ?)
      `).run('skip-scan-session', 'skip-scan-project', '/work/skip-scan', '2026-05-03T00:00:00Z');
      db.prepare(`
        INSERT INTO messages (id, session_id, role, content, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).run('skip-scan-message', 'skip-scan-session', 'user', 'readable message', '2026-05-03T00:00:00Z');
      dbManager.close();

      corruptRecoverableIndexPage(path.join(tmpDir, 'sessions.db'), 'idx_messages_timestamp');

      dbManager = new DatabaseManager(tmpDir);
      dbManager.setQuickCheckOnOpen(false);
      const reopenedDb = dbManager.getDb();
      await dbManager.waitForStartupIntegrityScan();

      assert.strictEqual(dbManager.getLastRecovery(), null);
      const sessionCount = reopenedDb.prepare('SELECT COUNT(*) AS count FROM sessions').get();
      assert.strictEqual(sessionCount.count, 1);
      reopenedDb.prepare(`
        INSERT INTO sessions (id, project, cwd, started_at)
        VALUES (?, ?, ?, ?)
      `).run('skip-scan-session-2', 'skip-scan-project', '/work/skip-scan', '2026-05-03T00:01:00Z');
      assert.strictEqual(reopenedDb.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 2);
    });

    it('quarantines unrecoverable files and recreates an empty database', () => {
      dbManager.close();
      const dbPath = path.join(tmpDir, 'sessions.db');
      fs.writeFileSync(dbPath, 'not a sqlite database');

      dbManager = new DatabaseManager(tmpDir);
      const db = dbManager.getDb();

      assert.strictEqual(dbManager.getLastRecovery()?.strategy, 'recreated-empty');
      assert.deepStrictEqual(dbManager.getStats(), { sessions: 0, messages: 0, memories: 0 });
      assertQuickCheckOk(db as InstanceType<typeof Database>);
      assert.ok(fs.readdirSync(tmpDir).some((name) => name.startsWith('sessions.db.corrupt-')), 'unrecoverable DB should be quarantined');
    });

    it('retries a corrupt operation once after self-healing', () => {
      dbManager.getDb();
      let attempts = 0;

      const result = dbManager.withCorruptionRecovery(() => {
        attempts++;
        if (attempts === 1) throw corruptSqliteError();
        return 'ok';
      });

      assert.strictEqual(result, 'ok');
      assert.strictEqual(attempts, 2);
      assert.strictEqual(dbManager.getLastRecovery()?.strategy, 'reused');
    });
  });

  describe('explicit integrity checks', () => {
    it('does not run quick_check or integrity_check during a normal open of an existing database', () => {
      dbManager.getDb();
      dbManager.close();

      const prototype = DatabaseManager.prototype as unknown as {
        assertIntegrityOk: (...args: unknown[]) => void;
      };
      const original = prototype.assertIntegrityOk;
      let checks = 0;
      prototype.assertIntegrityOk = function (...args: unknown[]) {
        checks++;
        return original.apply(this, args);
      };
      try {
        const reopened = new DatabaseManager(tmpDir);
        reopened.getDb();
        reopened.close();
        assert.strictEqual(checks, 0);
      } finally {
        prototype.assertIntegrityOk = original;
      }
    });

    it('runs full integrity_check explicitly and keeps connection configuration', () => {
      const db = dbManager.getDb();
      assert.strictEqual(db.pragma?.('foreign_keys', { simple: true }), 1);
      assert.strictEqual(db.pragma?.('journal_mode', { simple: true }), 'wal');
      assert.doesNotThrow(() => dbManager.checkIntegrity());
    });

    it('recovers latent corruption only for an explicit integrity check and rechecks the final generation', () => {
      const db = dbManager.getDb();
      db.prepare('INSERT INTO sessions (id, project, cwd, started_at) VALUES (?, ?, ?, ?)')
        .run('latent-session', 'project', '/tmp/project', '2026-08-09T00:00:00Z');
      db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run('latent-message', 'latent-session', 'user', 'preserve me', '2026-08-09T00:01:00Z');
      dbManager.close();
      corruptRecoverableIndexPage(path.join(tmpDir, 'sessions.db'), 'idx_messages_timestamp');

      dbManager = new DatabaseManager(tmpDir);
      assert.doesNotThrow(() => dbManager.getDb());
      assert.strictEqual(dbManager.getLastRecovery(), null);
      assert.throws(() => dbManager.checkIntegrity(), /database disk image is malformed|SQLite integrity_check failed/);
      const recovery = dbManager.recoverFromCorruption(new Error('SQLite integrity_check failed'));
      assert.strictEqual(recovery.strategy, 'rebuilt');
      assert.strictEqual(recovery.status, 'healthy');
      assert.doesNotThrow(() => dbManager.checkIntegrity());
      assert.strictEqual(
        (dbManager.getDb().prepare('SELECT content FROM messages WHERE session_id = ? AND entry_id = ?').get('latent-session', 'latent-message') as { content: string }).content,
        'preserve me',
      );
      assert.match(
        (dbManager.getDb().prepare('SELECT id FROM messages WHERE session_id = ? AND entry_id = ?').get('latent-session', 'latent-message') as { id: string }).id,
        /^idx:v1:/,
      );
    });

    it('marks unrecoverable recreation as degraded', () => {
      dbManager.close();
      fs.writeFileSync(path.join(tmpDir, 'sessions.db'), 'not a sqlite database');
      dbManager = new DatabaseManager(tmpDir);
      const result = dbManager.recoverFromCorruption(new Error('SQLite integrity_check failed'));
      assert.strictEqual(result.strategy, 'recreated-empty');
      assert.strictEqual(result.status, 'degraded');
    });
  });

  describe('close', () => {
    it('should close database connection', () => {
      const db = dbManager.getDb();
      assert.ok(db);
      dbManager.close();
      // After close, getDb should create a new connection
      const db2 = dbManager.getDb();
      assert.ok(db2);
      assert.notStrictEqual(db, db2);
    });

    it('should be safe to call close multiple times', () => {
      dbManager.getDb();
      assert.doesNotThrow(() => {
        dbManager.close();
        dbManager.close();
      });
    });

    it('should truncate the WAL file on close so it is not retained across sessions', () => {
      const db = dbManager.getDb();
      const walPath = `${dbManager.getPath()}-wal`;

      // Generate enough WAL traffic to materialize a non-trivial WAL file.
      const insert = db.prepare(`
        INSERT INTO memories (project, target, content, created, last_referenced)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < 500; i++) {
        insert.run(null, 'memory', `entry ${i} ${'x'.repeat(200)}`, '2026-05-03', '2026-05-03');
      }
      assert.ok(fs.existsSync(walPath), 'WAL file should exist after writes');
      assert.ok(fs.statSync(walPath).size > 0, 'WAL should be non-empty before close');

      // close() runs PRAGMA wal_checkpoint(TRUNCATE), which shrinks the WAL to 0.
      dbManager.close();

      const walSizeAfter = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
      assert.strictEqual(walSizeAfter, 0, 'WAL should be truncated to 0 bytes after close');
    });
  });

  describe('getStats', () => {
    it('should return zero counts for empty database', () => {
      dbManager.getDb();
      const stats = dbManager.getStats();
      assert.strictEqual(stats.sessions, 0);
      assert.strictEqual(stats.messages, 0);
      assert.strictEqual(stats.memories, 0);
    });

    it('should count inserted records', () => {
      const db = dbManager.getDb();

      // Insert a session
      db.prepare(`
        INSERT INTO sessions (id, project, cwd, started_at)
        VALUES (?, ?, ?, ?)
      `).run('test-session-1', 'test-project', '/test/cwd', '2026-05-03T00:00:00Z');

      // Insert a message
      db.prepare(`
        INSERT INTO messages (id, session_id, role, content, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).run('test-msg-1', 'test-session-1', 'user', 'Hello', '2026-05-03T00:01:00Z');

      // Insert a memory
      db.prepare(`
        INSERT INTO memories (project, target, content, created, last_referenced)
        VALUES (?, ?, ?, ?, ?)
      `).run(null, 'memory', 'prefers pnpm', '2026-05-03', '2026-05-03');

      const stats = dbManager.getStats();
      assert.strictEqual(stats.sessions, 1);
      assert.strictEqual(stats.messages, 1);
      assert.strictEqual(stats.memories, 1);
    });
  });

  describe('WAL mode', () => {
    it('should enable WAL mode for concurrent reads', () => {
      const db = dbManager.getDb();
      const result = db.pragma('journal_mode', { simple: true }) as string;
      assert.strictEqual(result, 'wal');
    });

    it('should use SQLite default-size WAL autocheckpoints', () => {
      const db = dbManager.getDb();
      const result = db.pragma('wal_autocheckpoint', { simple: true }) as number;
      assert.strictEqual(result, SQLITE_WAL_AUTOCHECKPOINT_PAGES);
    });
  });

  describe('foreign keys', () => {
    it('should enforce foreign key constraints', () => {
      const db = dbManager.getDb();
      const result = db.pragma('foreign_keys', { simple: true }) as number;
      assert.strictEqual(result, 1);

      // Inserting a message with non-existent session_id should fail
      assert.throws(() => {
        db.prepare(`
          INSERT INTO messages (id, session_id, role, content, timestamp)
          VALUES (?, ?, ?, ?, ?)
        `).run('bad-msg', 'nonexistent-session', 'user', 'test', '2026-05-03T00:00:00Z');
      }, /FOREIGN KEY/);
    });
  });
});

it('keeps deferred startup scan errors contained without treating SQLITE_BUSY as corruption', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'db-scan-busy-'));
  const manager = new DatabaseManager(root);
  const internal = manager as unknown as { verifySessionRepairInWorker: (...args: unknown[]) => Promise<void> };
  const original = internal.verifySessionRepairInWorker;
  let checked = false;
  internal.verifySessionRepairInWorker = async () => {
    checked = true;
    throw Object.assign(new Error('database is busy'), { code: 'SQLITE_BUSY' });
  };
  try {
    manager.getDb();
    await manager.waitForStartupIntegrityScan();
    assert.equal(checked, true);
    assert.equal(manager.getLastRecovery(), null);
    assert.equal(manager.getSessionRepairState()?.status, 'complete');
  } finally {
    internal.verifySessionRepairInWorker = original;
    manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
