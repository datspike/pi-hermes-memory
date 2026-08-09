import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AtomicLockCoordinator } from '../../src/store/atomic-lock-coordinator.js';
import { DatabaseManager } from '../../src/store/db.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-fencing-'));
}

function mutationKey(resource: string): string {
  return `mutation:${resource}:00000000-0000-4000-8000-000000000001`;
}

describe('recovery fencing', () => {
  it('blocks recovery while a live mutation is held and blocks mutations while recovery/publication is held', () => {
    const dir = tempDir();
    try {
      const locks = new AtomicLockCoordinator(path.join(dir, 'locks.sqlite'));
      const resource = path.join(dir, 'sessions.db');
      const mutation = locks.tryAcquire(mutationKey(resource), { staleMs: 0 });
      assert.ok(mutation);
      assert.equal(locks.tryAcquire(`recovery:${resource}`, { staleMs: 10 }), null);
      mutation.release();

      const recovery = locks.tryAcquire(`recovery:${resource}`, { staleMs: 10 });
      assert.ok(recovery);
      assert.equal(locks.tryAcquire(mutationKey(resource), { staleMs: 0 }), null);
      const publication = locks.acquirePublication(resource, recovery.token, { staleMs: 10 });
      assert.ok(publication);
      assert.equal(locks.tryAcquire(mutationKey(resource), { staleMs: 0 }), null);
      publication.release();
      recovery.release();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reclaims dead mutation owners but never steals an aged live mutation or publication', () => {
    const dir = tempDir();
    try {
      const dbPath = path.join(dir, 'locks.sqlite');
      const resource = path.join(dir, 'sessions.db');
      const db = new Database(dbPath);
      db.exec('CREATE TABLE locks (lock_key TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, incarnation TEXT, acquired_at INTEGER NOT NULL)');
      db.prepare('INSERT INTO locks VALUES (?, ?, ?, ?, ?)').run(mutationKey(resource), 'dead', 999999, null, Date.now() - 1000);
      db.close();
      const coordinator = new AtomicLockCoordinator(dbPath);
      const recovered = coordinator.tryAcquire(`recovery:${resource}`, { staleMs: 1 });
      assert.ok(recovered);
      recovered.release();

      const live = coordinator.tryAcquire(mutationKey(resource), { staleMs: 0 });
      assert.ok(live);
      const touch = new Database(dbPath);
      touch.prepare('UPDATE locks SET acquired_at = ? WHERE lock_key = ?').run(Date.now() - 1000, mutationKey(resource));
      assert.equal(coordinator.tryAcquire(`recovery:${resource}`, { staleMs: 1 }), null);
      live.release();
      touch.close();

      const recovery = coordinator.acquireRecovery(resource, { staleMs: 0 });
      assert.ok(recovery);
      const publication = coordinator.acquirePublication(resource, recovery.token, { staleMs: 0 });
      assert.ok(publication);
      const publicationTouch = new Database(dbPath);
      publicationTouch.prepare('UPDATE locks SET acquired_at = ? WHERE lock_key = ?').run(Date.now() - 1000, `publication:${resource}`);
      const contender = new AtomicLockCoordinator(dbPath);
      assert.equal(contender.acquirePublication(resource, recovery.token, { staleMs: 1 }), null);
      publication.release();
      recovery.release();
      publicationTouch.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exposes resource-aware mutation, recovery, and publication leases', () => {
    const dir = tempDir();
    try {
      const coordinator = new AtomicLockCoordinator(path.join(dir, 'locks.sqlite'));
      const resource = path.join(dir, 'sessions%_db');
      const firstMutation = coordinator.acquireMutation(resource, { staleMs: 0 });
      const secondMutation = coordinator.acquireMutation(resource, { staleMs: 0 });
      assert.ok(firstMutation);
      assert.ok(secondMutation);
      assert.equal(coordinator.acquireRecovery(resource, { staleMs: 10 }), null);
      firstMutation.release();
      secondMutation.release();
      const recovery = coordinator.acquireRecovery(resource, { staleMs: 10 });
      assert.ok(recovery);
      assert.equal(coordinator.acquirePublication(resource, 'wrong-token', { staleMs: 0 }), null);
      const publication = coordinator.acquirePublication(resource, recovery.token, { staleMs: 0 });
      assert.ok(publication);
      assert.equal(coordinator.acquireRecovery(resource, { staleMs: 10 }), null);
      publication.release();
      recovery.release();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires exact recovery owner identity for explicit and generic publication acquisition', () => {
    const dir = tempDir();
    try {
      const dbPath = path.join(dir, 'locks.sqlite');
      const resource = path.join(dir, 'sessions.db');
      const owner = new AtomicLockCoordinator(dbPath, { pid: 111111, incarnation: 'owner-inc', probeIncarnation: (pid) => pid === 111111 ? 'owner-inc' : null });
      const recovery = owner.acquireRecovery(resource, { staleMs: 0 });
      assert.ok(recovery);
      const attacker = new AtomicLockCoordinator(dbPath, { pid: 222222, incarnation: 'attacker-inc', probeIncarnation: (pid) => pid === 111111 ? 'owner-inc' : pid === 222222 ? 'attacker-inc' : null });
      assert.equal(attacker.acquirePublication(resource, recovery.token, { staleMs: 0 }), null);
      assert.equal(attacker.tryAcquire(`publication:${resource}`, { staleMs: 0 }), null);
      const sameOwner = new AtomicLockCoordinator(dbPath, { pid: 111111, incarnation: 'owner-inc', probeIncarnation: () => 'owner-inc' });
      const publication = sameOwner.acquirePublication(resource, recovery.token, { staleMs: 0 });
      assert.ok(publication);
      publication.release();
      recovery.release();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not let an aged live mutation or publication be stolen, and stale recovery cannot publish', () => {
    const dir = tempDir();
    try {
      const dbPath = path.join(dir, 'locks.sqlite');
      const resource = path.join(dir, 'sessions.db');
      const owner = new AtomicLockCoordinator(dbPath, { pid: process.pid, incarnation: 'owner', probeIncarnation: () => 'owner' });
      const mutation = owner.acquireMutation(resource, { staleMs: 1 });
      assert.ok(mutation);
      const raw = new Database(dbPath);
      raw.prepare('UPDATE locks SET acquired_at = ? WHERE lock_key LIKE ?').run(Date.now() - 1000, `mutation:${resource}:%`);
      raw.close();
      const contender = new AtomicLockCoordinator(dbPath, { pid: process.pid, incarnation: 'contender', probeIncarnation: () => 'owner' });
      assert.equal(contender.acquireRecovery(resource, { staleMs: 1 }), null);
      mutation.release();
      const recovery = owner.acquireRecovery(resource, { staleMs: 1 });
      assert.ok(recovery);
      const takeover = new AtomicLockCoordinator(dbPath, { pid: process.pid, incarnation: 'takeover', probeIncarnation: () => 'owner' });
      const touched = new Database(dbPath);
      touched.prepare('UPDATE locks SET acquired_at = ? WHERE lock_key = ?').run(Date.now() - 1000, `recovery:${resource}`);
      touched.close();
      const successor = takeover.acquireRecovery(resource, { staleMs: 1 });
      assert.ok(successor);
      assert.equal(takeover.acquirePublication(resource, recovery.token, { staleMs: 0 }), null);
      successor.release();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('escapes resource paths by matching mutation rows in TypeScript, not SQL LIKE', () => {
    const dir = tempDir();
    try {
      const coordinator = new AtomicLockCoordinator(path.join(dir, 'locks.sqlite'));
      const target = path.join(dir, 'db%_target');
      const unrelated = path.join(dir, 'dbXX_target');
      const mutation = coordinator.acquireMutation(unrelated, { staleMs: 0 });
      assert.ok(mutation);
      assert.ok(coordinator.acquireRecovery(target, { staleMs: 1 }));
      mutation.release();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reclaims only a proven-dead publication during explicit reconciliation', () => {
    const dir = tempDir();
    try {
      const dbPath = path.join(dir, 'locks.sqlite');
      const resource = path.join(dir, 'sessions.db');
      const seed = new Database(dbPath);
      seed.exec('CREATE TABLE locks (lock_key TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, incarnation TEXT, acquired_at INTEGER NOT NULL)');
      seed.prepare('INSERT INTO locks VALUES (?, ?, ?, ?, ?)').run(`publication:${resource}`, 'dead-publication', 999999, null, Date.now());
      seed.close();
      const coordinator = new AtomicLockCoordinator(dbPath);
      assert.equal(coordinator.acquireRecovery(resource, { staleMs: 0 }), null);
      const recovery = coordinator.acquireRecoveryForReconciliation(resource, { staleMs: 0 });
      assert.ok(recovery);
      assert.equal(coordinator.acquirePublication(resource, 'dead-publication', { staleMs: 0 }), null);
      recovery.release();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves token fencing and renews only the current owner', () => {
    const dir = tempDir();
    try {
      const coordinator = new AtomicLockCoordinator(path.join(dir, 'locks.sqlite'));
      const first = coordinator.tryAcquire('token-test', { staleMs: 1 });
      assert.ok(first);
      const db = new Database(path.join(dir, 'locks.sqlite'));
      db.prepare('UPDATE locks SET acquired_at = ? WHERE lock_key = ?').run(Date.now() - 100, 'token-test');
      const second = coordinator.tryAcquire('token-test', { staleMs: 1 });
      assert.ok(second);
      assert.equal(first.renew(), false);
      first.release();
      assert.equal(coordinator.isCurrentOwner('token-test', second.token), true);
      assert.equal(second.renew(), true);
      second.release();
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('stable database facade', () => {
  it('retains fluent statement methods and transaction modes', () => {
    const dir = tempDir();
    const manager = new DatabaseManager(dir);
    try {
      const db = manager.getDb();
      db.exec('CREATE TABLE values_test (value INTEGER)');
      const statement = db.prepare('SELECT value FROM values_test WHERE value = ?');
      assert.equal(statement.pluck?.(true), statement);
      assert.equal(statement.raw?.(true), statement);
      assert.equal(statement.expand?.(true), statement);
      db.prepare('INSERT INTO values_test VALUES (?)').run(1);
      const transaction = db.transaction((value: unknown) => db.prepare('INSERT INTO values_test VALUES (?)').run(value));
      transaction.immediate?.(2);
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM values_test').get() as { count: number }).count, 2);
    } finally {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exposes the stable facade through statement.database and keeps writes fenced', () => {
    const dir = tempDir();
    const manager = new DatabaseManager(dir);
    try {
      const db = manager.getDb();
      const statement = db.prepare('INSERT INTO extension_metadata (key, value) VALUES (?, ?)');
      const escaped = statement.database as typeof db;
      assert.strictEqual(escaped, db);
      manager.close();
      const databasePath = path.join(dir, 'sessions.db');
      const backupPath = path.join(dir, 'sessions.db.native-escape-backup');
      fs.renameSync(databasePath, backupPath);
      fs.copyFileSync(backupPath, databasePath);
      escaped.prepare('INSERT INTO extension_metadata (key, value) VALUES (?, ?)').run('native-escape', 'fenced');
      assert.deepEqual(manager.getDb().prepare("SELECT value FROM extension_metadata WHERE key = 'native-escape'").get(), { value: 'fenced' });
    } finally {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releases the mutation lease when generation rebind fails before opening a replacement', () => {
    const dir = tempDir();
    const manager = new DatabaseManager(dir);
    try {
      const db = manager.getDb();
      const oldWrite = db.prepare('INSERT INTO extension_metadata (key, value) VALUES (?, ?)');
      const databasePath = path.join(dir, 'sessions.db');
      const backupPath = path.join(dir, 'sessions.db.rebind-failure-backup');
      for (const suffix of ['', '-wal', '-shm']) {
        const source = `${databasePath}${suffix}`;
        if (fs.existsSync(source)) fs.renameSync(source, `${backupPath}${suffix}`);
      }
      assert.throws(() => oldWrite.run('should-not-exist', 'value'), /SQLite database path|canonical|ENOENT|no such file/i);
      const lockDb = new Database(path.join(dir, '.pi-hermes-locks.sqlite'));
      try {
        assert.equal((lockDb.prepare("SELECT COUNT(*) AS count FROM locks WHERE lock_key LIKE 'mutation:%'").get() as { count: number }).count, 0);
      } finally {
        lockDb.close();
      }
      assert.equal(fs.existsSync(databasePath), false);
    } finally {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears all savepoint state when RELEASE ends the native transaction', () => {
    const dir = tempDir();
    const manager = new DatabaseManager(dir);
    try {
      const db = manager.getDb();
      db.exec('SAVEPOINT a');
      db.exec('SAVEPOINT b');
      const lockDb = new Database(path.join(dir, '.pi-hermes-locks.sqlite'));
      assert.equal((lockDb.prepare("SELECT COUNT(*) AS count FROM locks WHERE lock_key LIKE 'mutation:%'").get() as { count: number }).count, 1);
      db.exec('RELEASE a');
      assert.equal(db.inTransaction, false);
      assert.equal((lockDb.prepare("SELECT COUNT(*) AS count FROM locks WHERE lock_key LIKE 'mutation:%'").get() as { count: number }).count, 0);
      lockDb.close();
    } finally {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps explicit BEGIN and savepoint leases until their terminal scope', () => {
    const dir = tempDir();
    const manager = new DatabaseManager(dir);
    try {
      const db = manager.getDb();
      db.exec('CREATE TABLE tx_test (value TEXT)');
      db.exec('BEGIN IMMEDIATE');
      const lockDb = new Database(path.join(dir, '.pi-hermes-locks.sqlite'));
      assert.equal((lockDb.prepare("SELECT COUNT(*) AS count FROM locks WHERE lock_key LIKE 'mutation:%'").get() as { count: number }).count, 1);
      db.prepare('INSERT INTO tx_test VALUES (?)').run('begin');
      db.exec('SAVEPOINT nested');
      db.prepare('INSERT INTO tx_test VALUES (?)').run('savepoint');
      db.exec('ROLLBACK TO nested');
      db.exec('RELEASE nested');
      assert.equal((lockDb.prepare("SELECT COUNT(*) AS count FROM locks WHERE lock_key LIKE 'mutation:%'").get() as { count: number }).count, 1);
      db.exec('COMMIT');
      assert.equal((lockDb.prepare("SELECT COUNT(*) AS count FROM locks WHERE lock_key LIKE 'mutation:%'").get() as { count: number }).count, 0);
      assert.deepEqual(db.prepare('SELECT value FROM tx_test').all(), [{ value: 'begin' }]);
      lockDb.close();
    } finally {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('binds once, lets invocation arguments override, and materializes iterate', () => {
    const dir = tempDir();
    const manager = new DatabaseManager(dir);
    try {
      const db = manager.getDb();
      db.exec('CREATE TABLE bind_test (value INTEGER)');
      const statement = db.prepare('INSERT INTO bind_test VALUES (?)').bind(7);
      statement.run(9);
      statement.run();
      assert.deepEqual(db.prepare('SELECT value FROM bind_test ORDER BY value').all(), [{ value: 7 }, { value: 9 }]);
      const iterator = db.prepare('SELECT value FROM bind_test ORDER BY value').iterate();
      assert.deepEqual(iterator, [{ value: 7 }, { value: 9 }]);
    } finally {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rebinds old prepared reads, writes, and transaction factories after a generation swap', () => {
    const dir = tempDir();
    const manager = new DatabaseManager(dir);
    try {
      const db = manager.getDb();
      const oldRead = db.prepare("SELECT value FROM extension_metadata WHERE key LIKE 'generation-%' ORDER BY rowid");
      const oldWrite = db.prepare('INSERT INTO extension_metadata (key, value) VALUES (?, ?)');
      const oldFactory = db.transaction((key: unknown, value: unknown) => oldWrite.run(key, value));
      manager.close();
      const databasePath = path.join(dir, 'sessions.db');
      const backupPath = path.join(dir, 'sessions.db.swap-backup');
      fs.renameSync(databasePath, backupPath);
      fs.copyFileSync(backupPath, databasePath);
      const rebound = manager.getDb();
      oldWrite.run('generation-rebound', 'rebound');
      oldFactory.immediate?.('generation-factory', 'factory');
      assert.deepEqual(oldRead.all(), [{ value: 'rebound' }, { value: 'factory' }]);
      assert.deepEqual(rebound.prepare("SELECT value FROM extension_metadata WHERE key LIKE 'generation-%' ORDER BY rowid").all(), [{ value: 'rebound' }, { value: 'factory' }]);
    } finally {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not replay an ambiguous mutating callback after recovery', () => {
    const dir = tempDir();
    const manager = new DatabaseManager(dir);
    let calls = 0;
    try {
      assert.throws(() => manager.withCorruptionRecovery(() => {
        calls++;
        manager.getDb().prepare('INSERT INTO definitely_missing VALUES (?)').run(1);
        throw Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' });
      }));
      assert.equal(calls, 1);
    } finally {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not replay a mutation after a corruption error', () => {
    const dir = tempDir();
    const manager = new DatabaseManager(dir);
    let calls = 0;
    try {
      assert.throws(() => manager.withCorruptionRecovery(() => {
        calls++;
        manager.getDb().prepare('INSERT INTO missing_table VALUES (?)').run(1);
        throw Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' });
      }));
      assert.equal(calls, 1);
    } finally {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
