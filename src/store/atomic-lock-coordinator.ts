import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { isBunRuntime, loadBetterSqlite3 } from './sqlite-native.js';

type StatementLike = {
  run: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
};

type DatabaseLike = {
  prepare: (sql: string) => StatementLike;
  exec: (sql: string) => void;
  close: () => void;
};

type DatabaseCtor = new (dbPath: string) => DatabaseLike;

type LockOwner = {
  lock_key: string;
  token: string;
  pid: number;
  incarnation: string | null;
  acquired_at: number;
};

export interface AtomicLockOptions {
  staleMs: number;
  /** Only recovery reconciliation may reclaim a proven-dead publication row. */
  reconcileDeadPublication?: boolean;
}

export interface AtomicLockLease {
  token: string;
  release: () => void;
  /**
   * Refresh the lease timestamp so a long-running-but-healthy holder is never
   * mistaken for a wedged one. Returns false once the lease has been taken
   * over, which is the holder's signal that it no longer owns the resource.
   */
  renew: () => boolean;
}

export interface AtomicLockCoordinatorOptions {
  pid?: number;
  incarnation?: string;
  probeIncarnation?: (pid: number) => string | null;
}

let cachedDatabaseCtor: DatabaseCtor | null = null;

/**
 * Resolved on first use, never at import time — see the same note in db.ts.
 * Compiled Pi cannot resolve better-sqlite3 at all, so Bun must take bun:sqlite.
 */
function getDatabaseCtor(): DatabaseCtor {
  if (!cachedDatabaseCtor) {
    const require = createRequire(import.meta.url);
    if (isBunRuntime()) {
      const bunSqlite = require('bun:sqlite') as { Database: DatabaseCtor };
      cachedDatabaseCtor = bunSqlite.Database;
    } else {
      cachedDatabaseCtor = loadBetterSqlite3({ requireImpl: require }) as DatabaseCtor;
    }
  }
  return cachedDatabaseCtor;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function probeProcessIncarnation(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const end = stat.lastIndexOf(')');
      const fields = stat.slice(end + 2).split(' ');
      return fields[19] || null;
    } catch {
      return null;
    }
  }

  if (process.platform !== 'win32') {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 250,
    });
    return result.status === 0 ? result.stdout.trim() || null : null;
  }

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Ticks`],
    { encoding: 'utf-8', timeout: 500 },
  );
  return result.status === 0 ? result.stdout.trim() || null : null;
}

// Deferred: probing our own incarnation spawns a helper process (powershell.exe
// costs ~1.4s on Windows) and is only needed once a lock is actually taken.
let currentProcessIncarnation: string | null | undefined;
function selfIncarnation(): string | null {
  if (currentProcessIncarnation === undefined) {
    currentProcessIncarnation = probeProcessIncarnation(process.pid);
  }
  return currentProcessIncarnation;
}
const RELEASE_ATTEMPTS = 3;
// Opportunistic dead-row GC: a row must be older than the grace period before
// a dead pid makes it collectable (guards against a pid we cannot observe, and
// against racing a holder that has just inserted its row), and each coordinator
// sweeps at most once per interval so acquisition stays cheap.
const DEAD_LOCK_SWEEP_GRACE_MS = 60_000;
const DEAD_LOCK_SWEEP_INTERVAL_MS = 60_000;
const pendingReleases = new Map<string, () => void>();
const sharedCoordinators = new Map<string, AtomicLockCoordinator>();

export class AtomicLockCoordinator {
  private readonly pid: number;
  private readonly incarnation: string | null;
  private readonly probeIncarnation: (pid: number) => string | null;
  private cachedDb: DatabaseLike | null = null;
  private lastSweepMs = 0;

  constructor(private readonly dbPath: string, options: AtomicLockCoordinatorOptions = {}) {
    this.pid = options.pid ?? process.pid;
    this.probeIncarnation = options.probeIncarnation
      ?? ((pid) => pid === process.pid ? selfIncarnation() : probeProcessIncarnation(pid));
    this.incarnation = options.incarnation
      ?? this.probeIncarnation(this.pid)
      ?? null;
  }

  private isMutationKey(key: string): boolean {
    return key.startsWith('mutation:') && key.lastIndexOf(':') > 'mutation:'.length;
  }

  private isBarrierKey(key: string): boolean {
    return key.startsWith('recovery:') || key.startsWith('publication:');
  }

  private barrierResource(key: string): string | null {
    if (key.startsWith('recovery:')) return key.slice('recovery:'.length);
    if (key.startsWith('publication:')) return key.slice('publication:'.length);
    if (this.isMutationKey(key)) return key.slice('mutation:'.length, key.lastIndexOf(':'));
    return null;
  }

  private holderIsLive(owner: { pid: number; incarnation: string | null }): boolean {
    const observedIncarnation = this.probeIncarnation(owner.pid);
    if (observedIncarnation !== null) {
      return owner.incarnation === null || owner.incarnation === observedIncarnation;
    }
    return processIsAlive(owner.pid);
  }

  /**
   * A publication row without an incarnation is not enough evidence to block
   * recovery forever: its PID may already belong to a successor process. Keep
   * the conservative holderIsLive path for ordinary owners and mutation
   * fencing; only journal reconciliation uses this stricter identity rule.
   */
  private publicationHolderIsLive(owner: LockOwner): boolean {
    if (owner.incarnation === null) return false;
    return this.holderIsLive(owner);
  }

  /** Acquire a short-lived mutation lease for one exact filesystem resource. */
  acquireMutation(resource: string, options: AtomicLockOptions): AtomicLockLease | null {
    return this.acquireResource('mutation', resource, options);
  }

  /** Acquire the recovery barrier, reclaiming dead mutation owners in the same transaction. */
  acquireRecovery(resource: string, options: AtomicLockOptions): AtomicLockLease | null {
    return this.acquireResource('recovery', resource, options);
  }

  /** Acquire recovery while explicitly reconciling a validated publication journal. */
  acquireRecoveryForReconciliation(resource: string, options: AtomicLockOptions): AtomicLockLease | null {
    return this.acquireResource('recovery', resource, { ...options, reconcileDeadPublication: true });
  }

  /** Acquire publication only as a token-fenced transition from the current recovery owner. */
  acquirePublication(resource: string, recoveryToken: string, options: AtomicLockOptions): AtomicLockLease | null {
    return this.acquireResource('publication', resource, options, recoveryToken);
  }

  tryAcquire(key: string, options: AtomicLockOptions): AtomicLockLease | null {
    if (this.isMutationKey(key)) {
      const resource = key.slice('mutation:'.length, key.lastIndexOf(':'));
      return this.acquireResourceWithKey('mutation', resource, key, options);
    }
    if (key.startsWith('recovery:')) return this.acquireRecovery(key.slice('recovery:'.length), options);
    if (key.startsWith('publication:')) {
      // Publication lineage is deliberately explicit. Never infer another
      // process's recovery token from the lock database.
      return null;
    }
    return this.acquireGeneric(key, options);
  }

  private acquireResource(
    kind: 'mutation' | 'recovery' | 'publication',
    resource: string,
    options: AtomicLockOptions,
    recoveryToken?: string,
  ): AtomicLockLease | null {
    const key = kind === 'mutation' ? `mutation:${resource}:${randomUUID()}` : `${kind}:${resource}`;
    return this.acquireResourceWithKey(kind, resource, key, options, recoveryToken);
  }

  private acquireResourceWithKey(
    kind: 'mutation' | 'recovery' | 'publication',
    resource: string,
    key: string,
    options: AtomicLockOptions,
    recoveryToken?: string,
  ): AtomicLockLease | null {
    if (kind === 'mutation') this.retryPendingMutationReleases(resource);
    else this.retryPendingReleases(key);
    if (kind !== 'mutation') this.retryPendingReleases(`publication:${resource}`);
    const token = randomUUID();
    const now = Date.now();
    const db = this.open();
    this.sweepDeadLocks(db, now);
    let acquired = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      const owner = db.prepare('SELECT token, pid, incarnation, acquired_at FROM locks WHERE lock_key = ?').get(key) as LockOwner | undefined;
      const recovery = db.prepare('SELECT token, pid, incarnation, acquired_at FROM locks WHERE lock_key = ?').get(`recovery:${resource}`) as LockOwner | undefined;
      const publication = db.prepare('SELECT token, pid, incarnation, acquired_at FROM locks WHERE lock_key = ?').get(`publication:${resource}`) as LockOwner | undefined;
      const mutationRows = db.prepare("SELECT lock_key, token, pid, incarnation, acquired_at FROM locks WHERE lock_key GLOB 'mutation:*'").all() as LockOwner[];
      const mutations = mutationRows.filter((row) => row.lock_key.startsWith(`mutation:${resource}:`));
      const liveMutations = mutations.filter((row) => this.holderIsLive(row));
      const liveRecovery = recovery ? this.holderIsLive(recovery) : false;
      const livePublication = publication ? this.holderIsLive(publication) : false;
      const reconciliationPublicationLive = publication ? this.publicationHolderIsLive(publication) : false;

      if (kind === 'mutation') {
        // A pending publication journal is itself a durable fence. It can remain
        // after the publication row is lost, so normal writes must wait for
        // startup reconciliation rather than mutate a generation that may be
        // replaced by the candidate.
        const pendingPublication = fs.existsSync(`${resource}.publication-state.json`);
        // Dead publication is deliberately retained: only recovery reconciliation
        // may clear it, so a normal write cannot enter a half-published window.
        if (!pendingPublication && !liveRecovery && !livePublication && !publication && (!owner || !this.holderIsLive(owner))) {
          if (owner) db.prepare('DELETE FROM locks WHERE lock_key = ? AND token = ?').run(key, owner.token);
          db.prepare('INSERT INTO locks (lock_key, token, pid, incarnation, acquired_at) VALUES (?, ?, ?, ?, ?)')
            .run(key, token, this.pid, this.incarnation, now);
          acquired = true;
        }
      } else if (kind === 'recovery') {
        for (const row of mutations) {
          if (!this.holderIsLive(row)) db.prepare('DELETE FROM locks WHERE lock_key = ? AND token = ?').run(row.lock_key, row.token);
        }
        const unknownLivePublicationNeedsGrace = Boolean(
          publication
          && publication.incarnation === null
          && processIsAlive(publication.pid)
          && options.staleMs > 0
          && now - publication.acquired_at < options.staleMs,
        );
        const publicationCanBeReclaimed = Boolean(
          options.reconcileDeadPublication
          && publication
          && !reconciliationPublicationLive
          && !unknownLivePublicationNeedsGrace,
        );
        if ((!publication || publicationCanBeReclaimed) && liveMutations.length === 0 && (!recovery || !liveRecovery || (options.staleMs > 0 && now - recovery.acquired_at >= options.staleMs))) {
          if (publicationCanBeReclaimed) {
            db.prepare('DELETE FROM locks WHERE lock_key = ? AND token = ?').run(`publication:${resource}`, publication!.token);
          }
          if (recovery) db.prepare('UPDATE locks SET token = ?, pid = ?, incarnation = ?, acquired_at = ? WHERE lock_key = ? AND token = ?').run(token, this.pid, this.incarnation, now, key, recovery.token);
          else db.prepare('INSERT INTO locks (lock_key, token, pid, incarnation, acquired_at) VALUES (?, ?, ?, ?, ?)').run(key, token, this.pid, this.incarnation, now);
          acquired = true;
        }
      } else if (
        recovery
        && recovery.token === recoveryToken
        && recovery.pid === this.pid
        && recovery.incarnation === this.incarnation
        && liveRecovery
        && !publication
      ) {
        // Publication CAS is bound to the exact recovery owner identity, not
        // merely to a token copied from another process.
        db.prepare('INSERT INTO locks (lock_key, token, pid, incarnation, acquired_at) VALUES (?, ?, ?, ?, ?)')
          .run(key, token, this.pid, this.incarnation, now);
        acquired = true;
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { this.discardCachedDb(); }
      throw error;
    }
    return acquired ? { token, release: () => this.release(key, token), renew: () => this.renew(key, token) } : null;
  }

  private acquireGeneric(key: string, options: AtomicLockOptions): AtomicLockLease | null {
    this.retryPendingReleases(key);
    const token = randomUUID();
    const now = Date.now();
    const db = this.open();
    this.sweepDeadLocks(db, now);
    let acquired = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      const owner = db.prepare('SELECT token, pid, incarnation, acquired_at FROM locks WHERE lock_key = ?').get(key) as LockOwner | undefined;
      if (!owner) {
        db.prepare('INSERT INTO locks (lock_key, token, pid, incarnation, acquired_at) VALUES (?, ?, ?, ?, ?)').run(key, token, this.pid, this.incarnation, now);
        acquired = true;
      } else if (!this.holderIsLive(owner) || (options.staleMs > 0 && now - owner.acquired_at >= options.staleMs)) {
        db.prepare('UPDATE locks SET token = ?, pid = ?, incarnation = ?, acquired_at = ? WHERE lock_key = ? AND token = ?').run(token, this.pid, this.incarnation, now, key, owner.token);
        acquired = true;
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { this.discardCachedDb(); }
      throw error;
    }
    return acquired ? { token, release: () => this.release(key, token), renew: () => this.renew(key, token) } : null;
  }

  private readOwner(key: string): LockOwner | undefined {
    return this.open().prepare('SELECT token, pid, incarnation, acquired_at FROM locks WHERE lock_key = ?').get(key) as LockOwner | undefined;
  }

  /** Read only whether an active publication row exists for startup fencing. */
  hasPublication(resource: string): boolean {
    return Boolean(this.readOwner(`publication:${resource}`));
  }

  /** Read only whether the recovery barrier is currently held. */
  hasRecovery(resource: string): boolean {
    return Boolean(this.readOwner(`recovery:${resource}`));
  }

  /**
   * Fencing check for destructive operations that lack their own independent
   * compare-and-swap (e.g. a plain fs.renameSync with no content/inode
   * verification). A lease can be legitimately stolen from a stale-but-alive
   * holder (see tryAcquire); a holder resuming after being stuck must verify
   * it is still the current owner immediately before publishing, or abort.
   * This narrows — it cannot fully close — the check-then-act race, since
   * synchronous work between this call and the actual write is not atomic
   * with it.
   */
  isCurrentOwner(key: string, token: string): boolean {
    const db = this.open();
    const row = db.prepare('SELECT token FROM locks WHERE lock_key = ?').get(key) as { token: string } | undefined;
    return row?.token === token;
  }

  /**
   * Execute a destructive filesystem action while the ownership row is held by
   * an IMMEDIATE transaction. This closes the check-then-act window: a stale
   * takeover cannot commit until the rename/remove has finished.
   */
  withCurrentOwner<T>(key: string, token: string, action: () => T): T {
    const db = this.open();
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT token FROM locks WHERE lock_key = ?').get(key) as { token: string } | undefined;
      if (row?.token !== token) throw new Error(`SQLite recovery lease lost for ${key}`);
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { this.discardCachedDb(); }
      throw error;
    }
  }

  /**
   * Extend a held lease. A holder whose work legitimately outlives staleMs
   * (a consolidation child can run for minutes) must beat periodically or a
   * peer will reclaim the lease out from under it. Beating also lets staleMs
   * stay short, so a holder that stops making progress is reclaimed in
   * seconds instead of after its worst-case runtime.
   *
   * Token-fenced: a lease that has already been taken over renews nothing and
   * returns false.
   */
  renew(key: string, token: string): boolean {
    const db = this.open();
    db.exec('BEGIN IMMEDIATE');
    try {
      const owner = db.prepare('SELECT token FROM locks WHERE lock_key = ?').get(key) as { token: string } | undefined;
      const owned = owner?.token === token;
      if (owned) {
        db.prepare('UPDATE locks SET acquired_at = ? WHERE lock_key = ? AND token = ?').run(Date.now(), key, token);
      }
      db.exec('COMMIT');
      return owned;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        this.discardCachedDb();
      }
      throw error;
    }
  }

  release(key: string, token: string): void {
    const pendingKey = this.pendingReleaseKey(key, token);
    for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt++) {
      try {
        this.deleteOwnedLock(key, token);
        pendingReleases.delete(pendingKey);
        return;
      } catch {
      }
    }
    pendingReleases.set(pendingKey, () => this.release(key, token));
  }

  private deleteOwnedLock(key: string, token: string): void {
    const db = this.open();
    db.prepare('DELETE FROM locks WHERE lock_key = ? AND token = ?').run(key, token);
  }

  /**
   * Delete rows whose holder process is gone.
   *
   * Without this, a row is only ever reclaimed by a peer that asks for the
   * same lock key again. A key belonging to an identity that never returns
   * (a deleted project, a one-shot `pi -p` run) leaks its row forever, and a
   * much later session using that identity pays a spurious wait.
   *
   * A dead process can never release or renew its lease, so deleting its row
   * is always safe. Probing happens outside any transaction and the DELETE is
   * fenced on (token, acquired_at) so a row re-taken in between is left alone.
   */
  private sweepDeadLocks(db: DatabaseLike, now: number): void {
    if (now - this.lastSweepMs < DEAD_LOCK_SWEEP_INTERVAL_MS) return;
    this.lastSweepMs = now;
    try {
      const rows = db
        .prepare('SELECT lock_key, token, pid, acquired_at FROM locks WHERE acquired_at <= ?')
        .all(now - DEAD_LOCK_SWEEP_GRACE_MS) as Array<{
          lock_key: string;
          token: string;
          pid: number;
          acquired_at: number;
        }>;
      const dead = rows.filter((row) => !row.lock_key.startsWith('publication:') && this.holderIsGone(row.pid));
      if (dead.length === 0) return;
      const remove = db.prepare('DELETE FROM locks WHERE lock_key = ? AND token = ? AND acquired_at = ?');
      for (const row of dead) {
        remove.run(row.lock_key, row.token, row.acquired_at);
      }
    } catch {
      // GC is best-effort — never fail an acquisition because of it.
    }
  }

  /** Same liveness test tryAcquire steals on, cheapest check first. */
  private holderIsGone(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    if (pid === this.pid) return false;
    if (processIsAlive(pid)) return false;
    return this.probeIncarnation(pid) === null;
  }

  private retryPendingReleases(key: string): void {
    const prefix = `${path.resolve(this.dbPath)}\0${key}\0`;
    for (const [pendingKey, release] of [...pendingReleases.entries()]) {
      if (pendingKey.startsWith(prefix)) release();
    }
  }

  private retryPendingMutationReleases(resource: string): void {
    const prefix = `${path.resolve(this.dbPath)}\0mutation:${resource}:`;
    for (const [pendingKey, release] of [...pendingReleases.entries()]) {
      if (pendingKey.startsWith(prefix)) release();
    }
  }

  private pendingReleaseKey(key: string, token: string): string {
    return `${path.resolve(this.dbPath)}\0${key}\0${token}`;
  }

  private discardCachedDb(): void {
    const db = this.cachedDb;
    this.cachedDb = null;
    if (db) {
      try { db.close(); } catch {}
    }
  }

  private open(): DatabaseLike {
    if (this.cachedDb) return this.cachedDb;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const existed = fs.existsSync(this.dbPath);
    const db = new (getDatabaseCtor())(this.dbPath);
    try {
      db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS locks (
          lock_key TEXT PRIMARY KEY,
          token TEXT NOT NULL,
          pid INTEGER NOT NULL,
          incarnation TEXT,
          acquired_at INTEGER NOT NULL
        );
      `);
      const columns = db.prepare('PRAGMA table_info(locks)').all() as Array<{ name: string }>;
      if (!columns.some(({ name }) => name === 'incarnation')) {
        try {
          db.exec('ALTER TABLE locks ADD COLUMN incarnation TEXT');
        } catch (error) {
          const refreshed = db.prepare('PRAGMA table_info(locks)').all() as Array<{ name: string }>;
          if (!refreshed.some(({ name }) => name === 'incarnation')) throw error;
        }
      }
      if (!existed) fs.chmodSync(this.dbPath, 0o600);
      this.cachedDb = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /**
   * Process-wide coordinator for `dbPath`.
   *
   * Each instance now pins its SQLite connection for its own lifetime, so a
   * caller that constructs a fresh coordinator per operation would leak one
   * open WAL connection per call. Every default-options caller must share.
   * The option-carrying constructor stays public for tests, which pass a
   * synthetic pid/incarnation that a dbPath-keyed cache would silently ignore.
   */
  static shared(dbPath: string): AtomicLockCoordinator {
    const key = path.resolve(dbPath);
    let coordinator = sharedCoordinators.get(key);
    if (!coordinator) {
      coordinator = new AtomicLockCoordinator(dbPath);
      sharedCoordinators.set(key, coordinator);
    }
    return coordinator;
  }
}
