import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { SCHEMA_SQL } from './schema.js';
import { AtomicLockCoordinator } from './atomic-lock-coordinator.js';
import { canonicalStoragePathSync } from './canonical-storage-path.js';
import { isBunRuntime, loadBetterSqlite3 } from './sqlite-native.js';

type StatementLike = {
  run: (...args: any[]) => any;
  get: (...args: any[]) => any;
  all: (...args: any[]) => any;
  iterate?: (...args: any[]) => Iterable<Record<string, unknown>>;
  bind?: (...args: any[]) => StatementLike;
  pluck?: (value?: boolean) => StatementLike;
  expand?: (value?: boolean) => StatementLike;
  raw?: (value?: boolean) => StatementLike;
  columns?: () => unknown;
  safeIntegers?: (value?: boolean) => StatementLike;
  source?: string;
  database?: unknown;
  reader?: boolean;
  readonly?: boolean;
  busy?: boolean;
};

type DatabaseLike = {
  prepare: (sql: string) => StatementLike;
  exec: (sql: string) => void;
  close: () => void;
  pragma?: (query: string, options?: any) => any;
  transaction?: (fn: any) => any;
  function?: (...args: any[]) => any;
  aggregate?: (...args: any[]) => any;
  table?: (...args: any[]) => any;
  loadExtension?: (...args: any[]) => any;
  backup?: (...args: any[]) => any;
  serialize?: (...args: any[]) => any;
  unsafeMode?: (...args: any[]) => any;
  defaultSafeIntegers?: (...args: any[]) => any;
  open?: boolean;
  inTransaction?: boolean;
  name?: string;
  memory?: boolean;
  readonly?: boolean;
};

type DatabaseCtor = new (dbPath: string) => DatabaseLike;
type BunDatabaseInstance = {
  prepare: (sql: string) => StatementLike;
  exec: (sql: string) => void;
  close: (throwOnError?: boolean) => void;
  transaction?: (fn: any) => any;
};

type DatabaseFileSuffix = '' | '-wal' | '-shm';

type PublicationPhase = 'prepared' | 'temp-verified' | 'quarantine' | 'published' | 'verified';
type PublicationJournal = {
  version: 1;
  canonicalPath: string;
  recoveryToken: string;
  phase: PublicationPhase;
  tempPath: string;
  backupBase: string;
  plannedSuffixes: DatabaseFileSuffix[];
  movedSuffixes: DatabaseFileSuffix[];
};

export interface DatabaseRecoveryResult {
  strategy: 'rebuilt' | 'recreated-empty' | 'reused';
  status: 'healthy' | 'degraded';
  backupPaths: string[];
  recoveredRows?: Record<string, number>;
  error?: string;
}

export class SessionEvidenceUnavailableError extends Error {
  code = 'SESSION_EVIDENCE_UNAVAILABLE';

  constructor(message = 'Session evidence is unavailable while database migration is incomplete') {
    super(message);
    this.name = 'SessionEvidenceUnavailableError';
  }
}

export type SessionRepairPhase = 'rows' | 'duplicates' | 'message_fts' | 'memory_fts' | 'verify';

export interface SessionRepairState {
  version: 1;
  status: 'pending' | 'running' | 'aborted' | 'complete';
  phase?: SessionRepairPhase;
  cursor: number;
  total: number;
  processed: number;
  updatedAt: string;
  completedAt?: string;
  /** Internal durable cursor for cooperative external-content FTS publication. */
  ftsInitialized?: boolean;
}

export interface SessionRepairChunkOptions {
  /** Maximum synchronous occupancy of one resumable micro-chunk. */
  wallClockBudgetMs?: number;
  chunkSize?: number;
  signal?: AbortSignal;
  yieldFn?: () => Promise<void>;
}

export interface DatabaseRecoveryOptions {
  recoveryLockWaitMs?: number;
  recoveryLockPollMs?: number;
  recoveryLockStaleMs?: number;
  recoveryCircuitLimit?: number;
  recoveryCircuitWindowMs?: number;
  recoveryBackupRetention?: number;
}

interface ResolvedDatabaseRecoveryOptions {
  recoveryLockWaitMs: number;
  recoveryLockPollMs: number;
  recoveryLockStaleMs: number;
  recoveryCircuitLimit: number;
  recoveryCircuitWindowMs: number;
  recoveryBackupRetention: number;
}

class DatabaseCorruptionError extends Error {
  code = 'SQLITE_CORRUPT';

  constructor(message: string) {
    super(message);
    this.name = 'DatabaseCorruptionError';
  }
}

export const SQLITE_BUSY_TIMEOUT_MS = 5000;
export const SQLITE_WAL_AUTOCHECKPOINT_PAGES = 1000;

const DATABASE_FILE_SUFFIXES: readonly DatabaseFileSuffix[] = ['', '-wal', '-shm'];
const SESSION_REPAIR_VERSION = 2;
const SESSION_REPAIR_STATE_KEY = 'session_repair_state:v1';
const DEFAULT_SESSION_REPAIR_CHUNK_SIZE = 16;
const DEFAULT_SESSION_REPAIR_WALL_CLOCK_BUDGET_MS = 35;
const KNOWN_FTS_TABLES = new Set([
  'message_fts', 'message_fts_data', 'message_fts_idx', 'message_fts_content', 'message_fts_docsize', 'message_fts_config',
  'memory_fts', 'memory_fts_data', 'memory_fts_idx', 'memory_fts_content', 'memory_fts_docsize', 'memory_fts_config',
]);
const PUBLICATION_PHASES = new Set<PublicationPhase>(['prepared', 'temp-verified', 'quarantine', 'published', 'verified']);
const MEMORY_TARGETS = new Set(['memory', 'user', 'failure']);
const MEMORY_CATEGORIES = new Set(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk']);
const DEFAULT_RECOVERY_OPTIONS: ResolvedDatabaseRecoveryOptions = {
  recoveryLockWaitMs: 5000,
  recoveryLockPollMs: 50,
  recoveryLockStaleMs: 300000,
  recoveryCircuitLimit: 3,
  recoveryCircuitWindowMs: 300000,
  recoveryBackupRetention: 3,
};

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function appendDiagnostic(value: unknown, diagnostic: string): string {
  let diagnostics: string[] = [];
  if (typeof value === 'string' && value) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) diagnostics = parsed.filter((entry): entry is string => typeof entry === 'string');
      else diagnostics = [value];
    } catch {
      diagnostics = [value];
    }
  }
  if (!diagnostics.includes(diagnostic)) diagnostics.push(diagnostic);
  return JSON.stringify(diagnostics);
}

function createBunCompatDatabaseCtor(require: NodeRequire): DatabaseCtor {
  const bunSqlite = require('bun:sqlite') as { Database: new (dbPath: string) => BunDatabaseInstance };

  return class BunCompatDatabase implements DatabaseLike {
    private readonly db: BunDatabaseInstance;

    constructor(dbPath: string) {
      this.db = new bunSqlite.Database(dbPath);
    }

    prepare(sql: string): StatementLike {
      return this.db.prepare(sql);
    }

    exec(sql: string): void {
      this.db.exec(sql);
    }

    close(): void {
      this.db.close();
    }

    transaction(fn: any): any {
      if (!this.db.transaction) {
        return undefined;
      }
      return this.db.transaction(fn);
    }
  };
}

let cachedDatabaseCtor: DatabaseCtor | null = null;

/**
 * Resolved on first use, never at import time. A module-scope native load turns
 * any SQLite resolve/ABI failure into "Failed to load extension", which hides
 * the actionable rebuild message and bricks the whole extension (issue #117).
 */
function getDatabaseCtor(): DatabaseCtor {
  if (!cachedDatabaseCtor) {
    const require = createRequire(import.meta.url);
    cachedDatabaseCtor = isBunRuntime()
      ? createBunCompatDatabaseCtor(require)
      : (loadBetterSqlite3({ requireImpl: require }) as DatabaseCtor);
  }
  return cachedDatabaseCtor;
}

const READ_ONLY_PRAGMAS = new Set(['quick_check', 'integrity_check', 'foreign_key_check', 'table_info', 'index_list', 'index_info', 'database_list', 'compile_options', 'busy_timeout']);

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*(?:\n|$)/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
}

type TransactionControl =
  | { kind: 'begin'; mode?: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE' }
  | { kind: 'commit' }
  | { kind: 'rollback'; toSavepoint: boolean }
  | { kind: 'savepoint' }
  | { kind: 'release' };

function parseTransactionControl(sql: string): TransactionControl | null {
  const normalized = stripSqlComments(sql).trim().replace(/;\s*$/, '').trim();
  // Multi-statement scripts retain native exec() semantics. Only a script that
  // is exactly one transaction-control statement participates in lease scope.
  if (/[;]\s*\S/.test(normalized)) return null;
  let match = normalized.match(/^BEGIN(?:\s+(DEFERRED|IMMEDIATE|EXCLUSIVE))?$/i);
  if (match) return { kind: 'begin', mode: match[1]?.toUpperCase() as 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE' | undefined };
  if (/^(?:COMMIT|END)$/i.test(normalized)) return { kind: 'commit' };
  if (/^ROLLBACK(?:\s+TO(?:\s+SAVEPOINT)?\s+\S+)?$/i.test(normalized)) return { kind: 'rollback', toSavepoint: /^ROLLBACK\s+TO\b/i.test(normalized) };
  if (/^SAVEPOINT\s+\S+$/i.test(normalized)) return { kind: 'savepoint' };
  if (/^RELEASE(?:\s+SAVEPOINT)?\s+\S+$/i.test(normalized)) return { kind: 'release' };
  return null;
}

function sqlOperation(sql: string): 'read' | 'write' | 'transaction' | 'unknown' {
  const normalized = stripSqlComments(sql).trim();
  const control = parseTransactionControl(normalized);
  if (control) return 'transaction';
  const cteWrite = /^WITH\b[\s\S]*?\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(normalized);
  const keyword = (cteWrite ? normalized.match(/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i)?.[1] : normalized.match(/^([A-Za-z]+)/)?.[1])?.toUpperCase();
  if (keyword === 'SELECT' || keyword === 'VALUES' || keyword === 'EXPLAIN') return 'read';
  if (keyword && ['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'ALTER', 'DROP', 'VACUUM', 'REINDEX', 'ANALYZE', 'ATTACH', 'DETACH'].includes(keyword)) return 'write';
  return 'unknown';
}

function randomToken(): string { return randomUUID(); }

class StableDatabaseFacade implements DatabaseLike {
  private explicitMutationLease: { release: () => void } | null = null;
  private explicitSavepointDepth = 0;
  private transactionDepth = 0;

  constructor(private readonly manager: DatabaseManager) {}

  prepare(sql: string): StatementLike {
    const facade = this;
    const operation = sqlOperation(sql);
    let boundArgs: unknown[] | null = null;
    let pluck: boolean | undefined;
    let expand: boolean | undefined;
    let raw: boolean | undefined;
    let safeIntegers: boolean | undefined;
    const nativeStatement = (): StatementLike => {
      const native = facade.manager.rawDb().prepare(sql);
      if (pluck !== undefined) native.pluck?.(pluck);
      if (expand !== undefined) native.expand?.(expand);
      if (raw !== undefined) native.raw?.(raw);
      if (safeIntegers !== undefined) native.safeIntegers?.(safeIntegers);
      return native;
    };
    const argumentsFor = (args: unknown[]): unknown[] => args.length > 0 ? args : boundArgs ?? [];
    const statement: Record<string, unknown> = {
      run: (...args: unknown[]) => facade.withMutation(() => nativeStatement().run(...argumentsFor(args))),
      get: (...args: unknown[]) => operation === 'write' || operation === 'unknown'
        ? facade.withMutation(() => nativeStatement().get(...argumentsFor(args)))
        : nativeStatement().get(...argumentsFor(args)),
      all: (...args: unknown[]) => operation === 'write' || operation === 'unknown'
        ? facade.withMutation(() => nativeStatement().all(...argumentsFor(args)))
        : nativeStatement().all(...argumentsFor(args)),
      iterate: (...args: unknown[]) => operation === 'read'
        ? [...(nativeStatement().iterate?.(...argumentsFor(args)) ?? [])]
        : [...(facade.withMutation(() => nativeStatement().iterate?.(...argumentsFor(args))) ?? [])],
      bind: (...args: unknown[]) => { boundArgs = args; return statement; },
      pluck: (value = true) => { pluck = value; return statement; },
      expand: (value = true) => { expand = value; return statement; },
      raw: (value = true) => { raw = value; return statement; },
      safeIntegers: (value = true) => { safeIntegers = value; return statement; },
      columns: () => nativeStatement().columns?.(),
    };
    for (const property of ['source', 'reader', 'readonly', 'busy'] as const) {
      Object.defineProperty(statement, property, {
        enumerable: true,
        get: () => (facade.manager.rawDb().prepare(sql) as unknown as Record<string, unknown>)[property],
      });
    }
    Object.defineProperty(statement, 'database', {
      enumerable: true,
      get: () => facade.manager.getDb(),
    });
    return statement as StatementLike;
  }

  function(...args: unknown[]): unknown { return this.manager.rawDb().function?.(...args); }
  aggregate(...args: unknown[]): unknown { return this.manager.rawDb().aggregate?.(...args); }
  table(...args: unknown[]): unknown { return this.manager.rawDb().table?.(...args); }
  loadExtension(...args: unknown[]): unknown { return this.manager.rawDb().loadExtension?.(...args); }
  backup(...args: unknown[]): unknown { return this.manager.rawDb().backup?.(...args); }
  serialize(...args: unknown[]): unknown { return this.manager.rawDb().serialize?.(...args); }
  unsafeMode(...args: unknown[]): unknown { return this.manager.rawDb().unsafeMode?.(...args); }
  defaultSafeIntegers(...args: unknown[]): unknown { return this.manager.rawDb().defaultSafeIntegers?.(...args); }
  get open(): boolean | undefined { return this.manager.rawDb().open; }
  get inTransaction(): boolean | undefined { return this.manager.rawDb().inTransaction; }
  get name(): string | undefined { return this.manager.rawDb().name; }
  get memory(): boolean | undefined { return this.manager.rawDb().memory; }
  get readonly(): boolean | undefined { return this.manager.rawDb().readonly; }

  exec(sql: string): void {
    const operation = sqlOperation(sql);
    const control = parseTransactionControl(sql);
    const opensScope = control?.kind === 'begin' || control?.kind === 'savepoint';
    const closesTransaction = control?.kind === 'commit' || (control?.kind === 'rollback' && !control.toSavepoint);
    if (opensScope && !this.explicitMutationLease) this.explicitMutationLease = this.manager.acquireMutation();
    const shortLease = !this.explicitMutationLease && (operation === 'write' || operation === 'unknown')
      ? this.manager.acquireMutation()
      : null;
    if (!shortLease && !this.explicitMutationLease && operation === 'read') {
      this.manager.rawDb().exec(sql);
      return;
    }
    try {
      this.manager.rawDb().exec(sql);
      if (control?.kind === 'savepoint') this.explicitSavepointDepth++;
      if (control?.kind === 'release' && this.explicitSavepointDepth > 0) this.explicitSavepointDepth--;
    } catch (error) {
      const stillInTransaction = this.manager.rawDb().inTransaction === true;
      if ((opensScope || closesTransaction || control?.kind === 'release') && !stillInTransaction) {
        this.explicitSavepointDepth = 0;
        this.releaseExplicitLease();
      }
      shortLease?.release();
      throw error;
    }
    const stillInTransaction = this.manager.rawDb().inTransaction === true;
    if (control?.kind === 'release') {
      if (!stillInTransaction) {
        this.explicitSavepointDepth = 0;
        this.releaseExplicitLease();
      } else if (this.explicitSavepointDepth > 0) {
        this.explicitSavepointDepth--;
      }
    } else if (closesTransaction && !stillInTransaction) {
      this.explicitSavepointDepth = 0;
      this.releaseExplicitLease();
    }
    shortLease?.release();
  }

  pragma(query: string, options?: unknown): unknown {
    const name = stripSqlComments(query).split(/[\s(=]/, 1)[0].toLowerCase();
    const readOnly = READ_ONLY_PRAGMAS.has(name) && !/[=]/.test(query);
    return readOnly ? this.manager.rawDb().pragma?.(query, options) : this.withMutation(() => this.manager.rawDb().pragma?.(query, options));
  }

  transaction(fn: (...args: unknown[]) => unknown): ((...args: unknown[]) => unknown) & { deferred?: unknown; immediate?: unknown; exclusive?: unknown } {
    const facade = this;
    const invoke = (mode: string, args: unknown[]) => {
      const outer = facade.transactionDepth > 0;
      const lease = outer ? null : facade.manager.acquireMutation();
      facade.transactionDepth++;
      try {
        const nativeFactory = facade.manager.rawDb().transaction?.((...inner: unknown[]) => fn(...inner));
        if (!nativeFactory) throw new Error('SQLite transaction API is unavailable');
        const selected = mode === 'deferred' ? nativeFactory.deferred : mode === 'immediate' ? nativeFactory.immediate : mode === 'exclusive' ? nativeFactory.exclusive : nativeFactory;
        return selected(...args);
      } finally {
        facade.transactionDepth--;
        lease?.release();
      }
    };
    const factory = ((...args: unknown[]) => invoke('default', args)) as ((...args: unknown[]) => unknown) & { deferred?: unknown; immediate?: unknown; exclusive?: unknown };
    factory.deferred = (...args: unknown[]) => invoke('deferred', args);
    factory.immediate = (...args: unknown[]) => invoke('immediate', args);
    factory.exclusive = (...args: unknown[]) => invoke('exclusive', args);
    return factory;
  }

  private releaseExplicitLease(): void {
    const lease = this.explicitMutationLease;
    this.explicitMutationLease = null;
    lease?.release();
  }

  private withMutation<T>(work: () => T): T {
    if (this.explicitMutationLease || this.transactionDepth > 0) return work();
    const lease = this.manager.acquireMutation();
    try { return work(); } finally { lease.release(); }
  }

  resetAfterManagerClose(): void {
    this.explicitMutationLease = null;
    this.explicitSavepointDepth = 0;
    this.transactionDepth = 0;
  }

  close(): void {
    if (this.explicitMutationLease) {
      try { this.manager.rawDb().exec('ROLLBACK'); } finally { this.releaseExplicitLease(); }
    }
    this.manager.close();
  }
}

export class DatabaseManager {
  private db: DatabaseLike | null = null;
  private native: DatabaseLike | null = null;
  private facade: StableDatabaseFacade | null = null;
  private generation: { dev: number; ino: number } | null = null;
  private mutationLeaseDepth = 0;
  private mutationLease: { release: () => void } | null = null;
  private mutationSerial = 0;
  private readonly displayDbPath: string;
  private canonicalDbPath: string | null = null;
  private readonly recoveryOptions: ResolvedDatabaseRecoveryOptions;
  private lastRecovery: DatabaseRecoveryResult | null = null;
  private openGuard: (() => void) | null = null;
  private activeRecoveryLease: { coordinator: AtomicLockCoordinator; key: string; token: string } | null = null;
  private activePublicationLease: { coordinator: AtomicLockCoordinator; key: string; token: string } | null = null;
  /** Narrow deterministic fault seam used by publication crash-matrix tests. */
  private publicationFaultHook: ((stage: string, suffix?: DatabaseFileSuffix) => void) | null = null;

  constructor(memoryDir: string, recoveryOptions: DatabaseRecoveryOptions = {}) {
    this.displayDbPath = path.join(memoryDir, 'sessions.db');
    this.recoveryOptions = { ...DEFAULT_RECOVERY_OPTIONS, ...recoveryOptions };
  }

  private get dbPath(): string {
    if (!this.canonicalDbPath) {
      this.canonicalDbPath = canonicalStoragePathSync(this.displayDbPath);
    }
    return this.canonicalDbPath;
  }

  setOpenGuard(guard: (() => void) | null): void {
    this.openGuard = guard;
  }

  /**
   * True when an error indicates SQLite file/page corruption rather than a
   * normal constraint, migration, or query failure.
   */
  static isCorruptionError(err: unknown): boolean {
    if (!err) return false;

    const code = typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
    if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') return true;

    const message = DatabaseManager.errorMessage(err).toLowerCase();
    return message.includes('database disk image is malformed')
      || message.includes('file is not a database')
      || message.includes('database schema is corrupt')
      || message.includes('malformed database schema')
      || message.includes('btreeinitpage')
      || message.includes('sqlite_corrupt')
      || message.includes('sqlite_notadb');
  }

  private static errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }

  /** Return the stable SQL-storing facade; native handles never escape this boundary. */
  getDb(): DatabaseLike {
    if (!this.facade) this.facade = new StableDatabaseFacade(this);
    if (!this.native) {
      this.openGuard?.();
      this.native = this.open();
      this.generation = this.fileGeneration();
    } else if (!this.sameGeneration()) {
      this.rebindAfterSwap();
    }
    this.db = this.facade;
    return this.facade;
  }

  /** Internal native handle access used by the facade and recovery code only. */
  rawDb(): DatabaseLike {
    if (!this.native) this.getDb();
    else if (this.mutationLeaseDepth === 0 && !this.sameGeneration()) this.rebindAfterSwap();
    if (!this.native) throw new Error(`SQLite database is not open: ${this.displayDbPath}`);
    return this.native;
  }

  acquireMutation(): { release: () => void } {
    if (this.mutationLeaseDepth++ > 0) return { release: () => { this.mutationLeaseDepth--; } };
    this.mutationSerial++;
    const coordinator = AtomicLockCoordinator.shared(path.join(path.dirname(this.dbPath), '.pi-hermes-locks.sqlite'));
    const key = `mutation:${this.dbPath}:${randomToken()}`;
    const deadline = Date.now() + this.recoveryOptions.recoveryLockWaitMs;
    let lease = coordinator.tryAcquire(key, { staleMs: 0 });
    while (!lease && Date.now() < deadline) { DatabaseManager.sleepSync(this.recoveryOptions.recoveryLockPollMs); lease = coordinator.tryAcquire(key, { staleMs: 0 }); }
    if (!lease) {
      this.mutationLeaseDepth = 0;
      if (coordinator.hasRecovery(this.dbPath)) throw new Error(`SQLite recovery already in progress for ${this.displayDbPath}; timed out before schema initialization`);
      throw new Error(`SQLite mutation barrier timed out for ${this.displayDbPath}`);
    }
    this.mutationLease = lease;
    // The filesystem generation may have changed while the lock was being
    // acquired. Rebind once now, before any statement is prepared or run.
    try {
      if (this.native && !this.sameGeneration()) this.rebindAfterMutationLease();
    } catch (error) {
      this.mutationLease = null;
      this.mutationLeaseDepth = 0;
      lease.release();
      throw error;
    }
    return { release: () => { this.mutationLeaseDepth--; if (this.mutationLeaseDepth === 0) { this.mutationLease = null; lease.release(); } } };
  }

  private fileGeneration(): { dev: number; ino: number } | null { try { const s = fs.statSync(this.dbPath); return { dev: s.dev, ino: s.ino }; } catch { return null; } }
  private sameGeneration(): boolean { const next = this.fileGeneration(); return !!next && !!this.generation && next.dev === this.generation.dev && next.ino === this.generation.ino; }
  private rebindAfterSwap(): void {
    if (this.mutationLeaseDepth > 0) return;
    const old = this.native;
    this.native = this.open();
    this.generation = this.fileGeneration();
    if (old) this.safeClose(old);
  }

  /** Rebind under an already-held mutation lease without entering recovery. */
  private rebindAfterMutationLease(): void {
    if (!fs.existsSync(this.dbPath)) throw new Error(`SQLite database path is unavailable during mutation rebind: ${this.displayDbPath}`);
    const old = this.native;
    const next = this.openUnchecked();
    this.native = next;
    this.generation = this.fileGeneration();
    if (old) this.safeClose(old);
  }

  /**
   * Last self-heal performed by this manager, if any. Exposed for diagnostics
   * and tests; normal callers do not need it.
   */
  getLastRecovery(): DatabaseRecoveryResult | null {
    return this.lastRecovery;
  }

  /** Run a full integrity scan on an explicit operator request. */
  checkIntegrity(): void {
    this.assertIntegrityOk(this.getDb(), 'integrity_check', 'during explicit verification');
  }

  /**
   * Retry a DB operation once after quarantining/rebuilding a corrupt DB.
   */
  withCorruptionRecovery<T>(operation: () => T): T {
    const mutationSerial = this.mutationSerial;
    try {
      return operation();
    } catch (err) {
      const mutationAttempted = this.mutationSerial !== mutationSerial;
      if (!DatabaseManager.isCorruptionError(err)) throw err;
      this.recoverFromCorruption(err);
      if (mutationAttempted) throw err;
      return operation();
    }
  }

  /**
   * Close any open handle, rebuild/quarantine the DB file set, and let the next
   * getDb() reopen a clean database.
   */
  recoverFromCorruption(cause?: unknown): DatabaseRecoveryResult {
    const coordinator = AtomicLockCoordinator.shared(path.join(path.dirname(this.dbPath), '.pi-hermes-locks.sqlite'));
    const lockKey = `recovery:${this.dbPath}`;
    const deadline = Date.now() + this.recoveryOptions.recoveryLockWaitMs;
    let lease = coordinator.acquireRecovery(this.dbPath, { staleMs: this.recoveryOptions.recoveryLockStaleMs });
    while (!lease && Date.now() < deadline) {
      DatabaseManager.sleepSync(this.recoveryOptions.recoveryLockPollMs);
      lease = coordinator.acquireRecovery(this.dbPath, { staleMs: this.recoveryOptions.recoveryLockStaleMs });
    }
    if (!lease) throw new Error(`SQLite recovery already in progress for ${this.displayDbPath}; timed out before closing`);
    this.activeRecoveryLease = { coordinator, key: lockKey, token: lease.token };
    let recovery: DatabaseRecoveryResult;
    try {
      if (!this.close(true)) throw new Error(`SQLite recovery barrier timed out before closing ${this.displayDbPath}`);
      recovery = this.recoverDatabaseFile(cause, () => {});
    } finally {
      this.activeRecoveryLease = null;
      lease.release();
    }
    this.lastRecovery = recovery;
    return recovery;
  }

  /**
   * Open the database and initialize schema.
   */
  private open(): DatabaseLike {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.reconcilePendingJournalOnStartup();
    this.rejectOrphanPublicationOnStartup();
    this.waitForMissingPathRecovery();
    let barrier = this.activeRecoveryLease ? null : this.acquireMutation();
    try {
      return this.openUnchecked();
    } catch (err) {
      if (!DatabaseManager.isCorruptionError(err)) {
        throw err;
      }

      barrier?.release();
      barrier = null;
      const recovery = this.recoverDatabaseFile(err, () => {});
      this.lastRecovery = recovery;
      barrier = this.acquireMutation();
      return this.openUnchecked();
    } finally {
      barrier?.release();
    }
  }

  private openUnchecked(): DatabaseLike {
    const db = new (getDatabaseCtor())(this.dbPath);
    let ok = false;

    try {
      this.configureConnection(db);
      this.initializeSchema(db);
      ok = true;
      return db;
    } finally {
      if (!ok) {
        this.safeClose(db);
      }
    }
  }

  private configureConnection(db: DatabaseLike): void {
    // Wait briefly for concurrent writers across Pi processes instead of failing
    // immediately with SQLITE_BUSY. Connection-local; applies before WAL/schema.
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    // Enable WAL mode + FK enforcement for each connection. Keep SQLite's
    // default WAL autocheckpoint size; a very aggressive checkpoint cadence
    // increases the chance that abrupt VM/host shutdown catches a checkpoint.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`PRAGMA wal_autocheckpoint = ${SQLITE_WAL_AUTOCHECKPOINT_PAGES}`);
    db.exec('PRAGMA journal_size_limit = 5242880');
    db.exec('PRAGMA foreign_keys = ON');
  }

  private initializeSchema(db: DatabaseLike): void {
    // Refuse to migrate or later copy durable state we do not understand.
    this.assertRecoveryInventory(db);
    // Create tables and triggers
    try {
      db.exec(SCHEMA_SQL);
    } catch (err) {
      if (!this.isLegacySchemaError(err)) {
        throw err;
      }

      // Legacy DBs can be missing v0.6 failure-memory columns and/or the project
      // column on sessions/memories. Add missing columns, then retry schema.
      this.ensureLegacySchemaColumns(db);
      this.ensureSessionEntryColumns(db);
      db.exec(SCHEMA_SQL);
    }

    // Extra safety: only bounded schema prerequisites belong on the public
    // open path. Identity repair and FTS rebuild run as resumable work below.
    this.ensureLegacySchemaColumns(db);
    this.ensureSessionEntryColumns(db);
    this.migrateLegacyMemoriesTargetConstraint(db);
    const repairVersion = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
    const state = this.readSessionRepairState(db);
    // user_version is only a schema marker, never proof that durable repair
    // state and evidence publication completed together.
    if (Number(repairVersion?.user_version ?? 0) !== SESSION_REPAIR_VERSION || !state || state.status !== 'complete') {
      this.ensureSessionRepairState(db, Number(repairVersion?.user_version ?? 0) === SESSION_REPAIR_VERSION && !state);
    }
  }

  private ensureSessionRepairState(db: DatabaseLike, forcePending = false): void {
    const hasMessage = db.prepare('SELECT 1 AS present FROM messages LIMIT 1').get() as { present?: unknown } | undefined;
    const existing = this.readSessionRepairState(db);
    const empty = !forcePending && !hasMessage;
    const total = existing?.total ?? 0;
    const next: SessionRepairState = {
      version: 1,
      status: empty ? 'complete' : (existing?.status === 'aborted' ? 'aborted' : 'pending'),
      cursor: existing?.cursor ?? 0,
      total,
      processed: empty ? 0 : (existing?.processed ?? 0),
      updatedAt: new Date().toISOString(),
      ...(empty ? { completedAt: new Date().toISOString() } : {}),
    };
    db.prepare('INSERT INTO extension_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(SESSION_REPAIR_STATE_KEY, JSON.stringify(next));
    if (empty) {
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_entry_id ON messages(session_id, entry_id) WHERE entry_id IS NOT NULL');
      db.exec(`PRAGMA user_version = ${SESSION_REPAIR_VERSION}`);
    }
  }

  private readSessionRepairState(db: DatabaseLike): SessionRepairState | null {
    const row = db.prepare('SELECT value FROM extension_metadata WHERE key = ?').get(SESSION_REPAIR_STATE_KEY) as { value?: unknown } | undefined;
    if (typeof row?.value !== 'string') return null;
    try {
      const parsed = JSON.parse(row.value) as SessionRepairState;
      if (parsed?.version !== 1 || !['pending', 'running', 'aborted', 'complete'].includes(parsed.status)) return null;
      return parsed;
    } catch { return null; }
  }

  public getSessionRepairState(): SessionRepairState | null {
    const db = this.getDb();
    const state = this.readSessionRepairState(db);
    return state && state.status !== 'complete' ? state : state;
  }

  public assertSessionEvidenceAvailable(): void {
    const state = this.getSessionRepairState();
    if (state && state.status !== 'complete') throw new SessionEvidenceUnavailableError();
  }

  /** Process one fenced, wall-clock-bounded migration micro-chunk. */
  public async runSessionRepairChunk(options: SessionRepairChunkOptions = {}): Promise<SessionRepairState | null> {
    const coordinator = AtomicLockCoordinator.shared(path.join(path.dirname(this.dbPath), '.pi-hermes-locks.sqlite'));
    const lockKey = `session-repair:${this.dbPath}`;
    const lease = coordinator.tryAcquire(lockKey, { staleMs: 0 });
    if (!lease) return this.getSessionRepairState();
    const budgetMs = Math.max(1, options.wallClockBudgetMs ?? DEFAULT_SESSION_REPAIR_WALL_CLOCK_BUDGET_MS);
    try {
      const db = this.getDb();
      // Keep repair's WAL checkpoints small as well as its transactions; the
      // normal application checkpoint setting can create a multi-hundred-ms
      // pause after thousands of tiny durable updates.
      db.exec('PRAGMA wal_autocheckpoint = 100');
      let state = this.readSessionRepairState(db);
      if (!state || state.status === 'complete') return state;
      if (options.signal?.aborted) {
        state = { ...state, status: 'aborted', updatedAt: new Date().toISOString() };
        this.storeSessionRepairState(db, state);
        return state;
      }
      // Keep each synchronous transaction bounded even when the production
      // harness requests a very large batch. The cursor remains durable, so a
      // batch boundary never trades safety for throughput.
      const chunkSize = Math.max(1, Math.min(2_048, Math.floor(options.chunkSize ?? DEFAULT_SESSION_REPAIR_CHUNK_SIZE)));
      const boundedChunkSize = Math.max(1, Math.min(chunkSize, Math.floor(budgetMs * 32)));
      state = { ...state, status: 'running', phase: state.phase ?? 'rows', updatedAt: new Date().toISOString() };
      const commit = (work: () => void): void => {
        if (db.transaction) db.transaction(work)();
        else { db.exec('BEGIN IMMEDIATE'); try { work(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } }
      };

      if (state.phase === 'rows') {
        const messageColumns = this.getColumnNames(db, 'messages');
        const parentColumn = messageColumns.has('parent_id') ? ', parent_id' : '';
        const rows = db.prepare(`SELECT rowid, id, session_id, entry_id, ordinal, parent_entry_id${parentColumn}, tool_call_id, diagnostics
          FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?`).all(state.cursor, chunkSize) as Array<Record<string, unknown>>;
        const workRows = rows.slice(0, Math.max(1, Math.min(rows.length, boundedChunkSize)));
        commit(() => {
          const update = db.prepare('UPDATE messages SET id = ?, entry_id = ?, ordinal = ?, parent_entry_id = ?, tool_call_id = ?, diagnostics = ? WHERE rowid = ?');
          for (const row of workRows) {
            const oldId = typeof row.id === 'string' ? row.id : '';
            const sessionId = typeof row.session_id === 'string' ? row.session_id : '';
            const entryId = typeof row.entry_id === 'string' && row.entry_id ? row.entry_id : oldId || null;
            const storageId = oldId.startsWith('idx:v1:') ? oldId : `idx:v1:${createHash('sha256').update(JSON.stringify({ v: 1, sessionId, oldId, rowid: row.rowid })).digest('hex').slice(0, 32)}`;
            const ordinal = typeof row.ordinal === 'number' && row.ordinal > 0 ? Math.trunc(row.ordinal) : Number(row.rowid) - 1;
            const canonicalParent = typeof row.parent_entry_id === 'string' && row.parent_entry_id ? row.parent_entry_id : null;
            const legacyParent = typeof row.parent_id === 'string' && row.parent_id ? row.parent_id : null;
            let diagnostic: string | null = typeof row.diagnostics === 'string' ? row.diagnostics : null;
            if (legacyParent && canonicalParent && legacyParent !== canonicalParent) diagnostic = appendDiagnostic(diagnostic, 'legacy-parent-conflict');
            update.run(storageId, entryId, ordinal, canonicalParent ?? legacyParent, typeof row.tool_call_id === 'string' ? row.tool_call_id : null, diagnostic, row.rowid);
          }
        });
        if (workRows.length > 0) state = { ...state, cursor: Number(workRows[workRows.length - 1].rowid), processed: state.processed + workRows.length };
        else state = { ...state, phase: 'duplicates', cursor: 0 };
      } else if (state.phase === 'duplicates') {
        const uniqueIndex = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND sql LIKE 'CREATE UNIQUE INDEX%messages%session_id%entry_id%' LIMIT 1").get();
        if (uniqueIndex) {
          // Older production generations already enforce this invariant. Do
          // not rescan hundreds of thousands of rows just to rediscover it.
          state = { ...state, phase: 'message_fts', cursor: 0, ftsInitialized: false };
        } else {
          const rows = db.prepare(`SELECT rowid, session_id, entry_id FROM messages
            WHERE rowid > ? AND entry_id IS NOT NULL ORDER BY rowid LIMIT ?`).all(state.cursor, chunkSize) as Array<{ rowid: number; session_id: string; entry_id: string }>;
          const workRows = rows.slice(0, Math.max(1, Math.min(rows.length, boundedChunkSize)));
          commit(() => {
            const prior = db.prepare(`SELECT 1 FROM messages WHERE session_id = ? AND entry_id = ? AND rowid < ? LIMIT 1`);
            const clear = db.prepare('UPDATE messages SET entry_id = NULL, diagnostics = ? WHERE rowid = ?');
            for (const row of workRows) {
              if (prior.get(row.session_id, row.entry_id, row.rowid)) clear.run('ambiguous-entry-id', row.rowid);
            }
          });
          if (workRows.length > 0) {
            state = { ...state, cursor: Number(workRows[workRows.length - 1].rowid) };
          } else {
            commit(() => db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_entry_id ON messages(session_id, entry_id) WHERE entry_id IS NOT NULL'));
            state = { ...state, phase: 'message_fts', cursor: 0, ftsInitialized: false };
          }
        }
      } else if (state.phase === 'message_fts' || state.phase === 'memory_fts') {
        const table = state.phase === 'message_fts' ? 'message_fts' : 'memory_fts';
        const source = state.phase === 'message_fts' ? 'messages' : 'memories';
        const key = state.phase === 'message_fts' ? 'rowid' : 'id';
        if (!state.ftsInitialized) {
          // Existing external-content rows are not proof of full coverage.
          // Always walk the source in bounded chunks and upsert every row; this
          // repairs partially written FTS tables without a monolithic rebuild.
          state = { ...state, ftsInitialized: true, cursor: 0 };
        } else {
          const rows = db.prepare(`SELECT ${key} AS id, content FROM ${source} WHERE ${key} > ? ORDER BY ${key} LIMIT ?`).all(state.cursor, chunkSize) as Array<{ id: number; content: string }>;
          const workRows = rows.slice(0, Math.max(1, Math.min(rows.length, boundedChunkSize)));
          if (workRows.length > 0) {
            commit(() => {
              const insert = db.prepare(`INSERT OR REPLACE INTO ${table}(rowid, content) VALUES (?, ?)`);
              for (const row of workRows) insert.run(row.id, row.content);
            });
            state = { ...state, cursor: Number(workRows[workRows.length - 1].id) };
          } else {
            state = state.phase === 'message_fts'
              ? { ...state, phase: 'memory_fts', cursor: 0, ftsInitialized: false }
              : { ...state, phase: 'verify', cursor: 0, ftsInitialized: undefined };
          }
        }
      } else {
        // Keep the generation fence across verification and marker publication;
        // recovery cannot swap the canonical inode while this lease is held.
        const mutation = this.acquireMutation();
        try {
          const generation = this.generation;
          await this.verifySessionRepairInWorker(options.signal);
          if (!generation || !this.sameGeneration()) throw new Error('SQLite generation changed during session repair verification');
          commit(() => {
            db.exec(`PRAGMA user_version = ${SESSION_REPAIR_VERSION}`);
            const completed: SessionRepairState = { ...state!, status: 'complete', phase: undefined, completedAt: new Date().toISOString() };
            state = completed;
            this.storeSessionRepairState(db, completed);
          });
        } finally {
          mutation.release();
        }
      }
      state = { ...state, updatedAt: new Date().toISOString() };
      if (state.status !== 'complete') this.storeSessionRepairState(db, state);
      return state;
    } finally {
      lease.release();
      // A resolved no-op callback can still starve timers across thousands of
      // chunks. Yield to the macrotask queue by default; this is cooperative
      // scheduling, not a timing workaround.
      if (options.yieldFn) await options.yieldFn();
      else await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private storeSessionRepairState(db: DatabaseLike, state: SessionRepairState): void {
    db.prepare('INSERT INTO extension_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(SESSION_REPAIR_STATE_KEY, JSON.stringify(state));
  }

  private hasExistingMainDatabaseFile(): boolean {
    try {
      return fs.existsSync(this.dbPath) && fs.statSync(this.dbPath).size > 0;
    } catch {
      return false;
    }
  }

  private databaseFileSetExists(): boolean {
    return fs.existsSync(this.dbPath);
  }

  private reconcilePendingJournalOnStartup(): void {
    const journal = this.readPublicationJournal();
    if (!journal) return;
    const coordinator = AtomicLockCoordinator.shared(path.join(path.dirname(this.dbPath), '.pi-hermes-locks.sqlite'));
    const deadline = Date.now() + this.recoveryOptions.recoveryLockWaitMs;
    let lease = coordinator.acquireRecoveryForReconciliation(this.dbPath, { staleMs: this.recoveryOptions.recoveryLockStaleMs });
    while (!lease && Date.now() < deadline) {
      DatabaseManager.sleepSync(this.recoveryOptions.recoveryLockPollMs);
      lease = coordinator.acquireRecoveryForReconciliation(this.dbPath, { staleMs: this.recoveryOptions.recoveryLockStaleMs });
    }
    if (!lease) throw new Error(`SQLite publication journal is blocked by a live recovery/publication owner for ${this.displayDbPath}`);
    this.activeRecoveryLease = { coordinator, key: `recovery:${this.dbPath}`, token: lease.token };
    try {
      this.lastRecovery = this.reconcilePublicationJournal(journal, () => {}, coordinator);
    } finally {
      this.activeRecoveryLease = null;
      lease.release();
    }
  }

  private rejectOrphanPublicationOnStartup(): void {
    if (fs.existsSync(this.publicationJournalPath())) return;
    const lockDbPath = path.join(path.dirname(this.dbPath), '.pi-hermes-locks.sqlite');
    if (!fs.existsSync(lockDbPath)) return;
    const coordinator = AtomicLockCoordinator.shared(lockDbPath);
    if (coordinator.hasPublication(this.dbPath)) {
      throw new Error(`SQLite startup blocked by an unverifiable publication owner for ${this.displayDbPath}`);
    }
  }

  private waitForMissingPathRecovery(): void {
    if (this.databaseFileSetExists()) return;
    const hasSidecars = DATABASE_FILE_SUFFIXES.some((suffix) => suffix !== '' && fs.existsSync(`${this.dbPath}${suffix}`));
    if (!hasSidecars) return;
    const lockDbPath = path.join(path.dirname(this.dbPath), '.pi-hermes-locks.sqlite');
    if (!fs.existsSync(lockDbPath)) return;
    const coordinator = AtomicLockCoordinator.shared(lockDbPath);
    const key = `recovery:${this.dbPath}`;
    const deadline = Date.now() + this.recoveryOptions.recoveryLockWaitMs;
    const probe = coordinator.tryAcquire(key, { staleMs: 0 });
    if (probe) {
      probe.release();
      throw new Error(`SQLite canonical database main file is missing while sidecars remain: ${this.displayDbPath}`);
    }
    while (!this.databaseFileSetExists() && Date.now() < deadline) {
      DatabaseManager.sleepSync(this.recoveryOptions.recoveryLockPollMs);
    }
    if (!this.databaseFileSetExists()) {
      throw new Error(`SQLite canonical database main file is missing while sidecars remain: ${this.displayDbPath}`);
    }
  }

  private assertIntegrityOk(
    db: DatabaseLike,
    check: 'quick_check' | 'integrity_check' = 'quick_check',
    context = '',
  ): void {
    const rows = db.prepare(`PRAGMA ${check}`).all() as Record<string, unknown>[];
    const messages = rows.map((row) => String(Object.values(row)[0] ?? ''));
    const failures = messages.filter((message) => message.toLowerCase() !== 'ok');

    if (rows.length === 0 || failures.length > 0) {
      const detail = failures.length > 0 ? failures.slice(0, 5).join('\n') : 'no result rows';
      const suffix = context ? ` ${context}` : '';
      throw new DatabaseCorruptionError(`SQLite ${check} failed${suffix}: ${detail}`);
    }
  }

  private assertForeignKeysOk(db: DatabaseLike): void {
    const rows = db.prepare('PRAGMA foreign_key_check').all() as Record<string, unknown>[];
    if (rows.length > 0) {
      throw new Error(`SQLite foreign_key_check failed after verification (${rows.length} violation${rows.length === 1 ? '' : 's'})`);
    }
  }

  /** Run full SQLite verification off the extension event loop before publication. */
  private async verifySessionRepairInWorker(signal?: AbortSignal): Promise<void> {
    if (isBunRuntime()) {
      if (signal?.aborted) throw new Error('Session repair verification cancelled');
      const db = this.getDb();
      this.assertIntegrityOk(db, 'quick_check', 'after session repair');
      this.assertForeignKeysOk(db);
      return;
    }
    const sqliteModule = createRequire(import.meta.url).resolve('better-sqlite3');
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('Session repair verification cancelled')); return; }
      const child = spawn(process.execPath, ['-e', `
        const Database = require(process.env.PH009_SQLITE_MODULE);
        const db = new Database(process.env.PH009_DB_PATH, { readonly: true });
        try {
          const quick = db.prepare('PRAGMA quick_check').all();
          if (quick.some((row) => String(Object.values(row)[0] ?? '').toLowerCase() !== 'ok')) process.exitCode = 2;
          const foreign = db.prepare('PRAGMA foreign_key_check').all();
          if (foreign.length > 0) process.exitCode = 3;
        } finally { db.close(); }
      `], {
        env: { ...process.env, PH009_SQLITE_MODULE: sqliteModule, PH009_DB_PATH: this.dbPath },
        stdio: 'ignore',
        ...(process.platform === 'win32' ? {} : { nice: 10 }),
      });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        child.kill('SIGKILL');
        finish(new Error('SQLite worker verification timed out'));
      }, 30_000);
      const abort = () => {
        if (settled) return;
        child.kill('SIGTERM');
        setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 250);
        finish(new Error('SQLite worker verification cancelled'));
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      signal?.addEventListener('abort', abort, { once: true });
      child.once('error', (error) => finish(error));
      child.once('exit', (code) => code === 0 ? finish() : finish(new Error(`SQLite worker verification failed with exit code ${code}`)));
    });
  }

  private verifyFinalDatabase(db: DatabaseLike): void {
    this.assertIntegrityOk(db, 'integrity_check', 'after final recovery publication');
    this.assertForeignKeysOk(db);
  }

  private recoverDatabaseFile(cause: unknown, verify: () => void): DatabaseRecoveryResult {
    const coordinator = AtomicLockCoordinator.shared(path.join(path.dirname(this.dbPath), '.pi-hermes-locks.sqlite'));
    const lockKey = `recovery:${this.dbPath}`;
    const held = this.activeRecoveryLease;
    if (held) {
      return this.recoverDatabaseFileOwned(cause, verify, coordinator);
    }
    const deadline = Date.now() + Math.max(0, this.recoveryOptions.recoveryLockWaitMs);
    while (true) {
      const lease = this.readPublicationJournal()
        ? coordinator.acquireRecoveryForReconciliation(this.dbPath, { staleMs: this.recoveryOptions.recoveryLockStaleMs })
        : coordinator.acquireRecovery(this.dbPath, { staleMs: this.recoveryOptions.recoveryLockStaleMs });
      if (!lease) {
        if (Date.now() >= deadline) {
          throw new Error(`SQLite recovery already in progress for ${this.displayDbPath}; timed out after ${this.recoveryOptions.recoveryLockWaitMs}ms`);
        }
        DatabaseManager.sleepSync(Math.min(this.recoveryOptions.recoveryLockPollMs, Math.max(1, deadline - Date.now())));
        continue;
      }
      this.activeRecoveryLease = { coordinator, key: lockKey, token: lease.token };
      try {
        return this.recoverDatabaseFileOwned(cause, verify, coordinator);
      } finally {
        this.activeRecoveryLease = null;
        lease.release();
      }
    }
  }

  private recoverDatabaseFileOwned(
    cause: unknown,
    verify: () => void,
    coordinator: AtomicLockCoordinator,
  ): DatabaseRecoveryResult {
    this.assertRecoveryCircuitClosed();
    try {
      const pending = this.readPublicationJournal();
      if (pending) {
        const result = this.reconcilePublicationJournal(pending, verify, coordinator);
        this.clearRecoveryFailuresBestEffort();
        return result;
      }
      if (this.currentDatabaseIsHealthy()) {
        verify();
        this.clearRecoveryFailuresBestEffort();
        return { strategy: 'reused', status: 'healthy', backupPaths: [] };
      }
      const result = this.recoverDatabaseFileUnlocked(cause, verify, coordinator);
      this.cleanupRecoveryArtifactsBestEffort();
      this.clearRecoveryFailuresBestEffort();
      return result;
    } catch (error) {
      this.recordRecoveryFailure();
      throw error;
    }
  }

  private publicationJournalPath(): string {
    return `${this.dbPath}.publication-state.json`;
  }

  private syncDirectory(): void {
    try {
      const fd = fs.openSync(path.dirname(this.dbPath), 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTSUP' || code === 'EINVAL' || code === 'EBADF' || (process.platform === 'win32' && code === 'EPERM')) return;
      throw error;
    }
  }

  private writePublicationJournal(journal: PublicationJournal): void {
    this.validatePublicationJournal(journal);
    this.assertStillRecoveryOwner();
    const target = this.publicationJournalPath();
    const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
    const payload = JSON.stringify(journal);
    let fd: number | null = null;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeSync(fd, payload, undefined, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(temp, target);
      this.syncDirectory();
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch {} }
      if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
    }
  }

  private readPublicationJournal(): PublicationJournal | null {
    const journalPath = this.publicationJournalPath();
    if (!fs.existsSync(journalPath)) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8')); } catch { throw new Error(`SQLite publication journal is invalid: ${journalPath}`); }
    this.validatePublicationJournal(parsed);
    return parsed as PublicationJournal;
  }

  private validatePublicationJournal(value: unknown): asserts value is PublicationJournal {
    if (!value || typeof value !== 'object') throw new Error('SQLite publication journal is invalid');
    const journal = value as Record<string, unknown>;
    const journalKeys = Object.keys(journal).sort();
    if (journalKeys.join(',') !== 'backupBase,canonicalPath,movedSuffixes,phase,plannedSuffixes,recoveryToken,tempPath,version'
      || journal.version !== 1 || typeof journal.canonicalPath !== 'string' || journal.canonicalPath !== this.dbPath
      || typeof journal.recoveryToken !== 'string' || !journal.recoveryToken
      || typeof journal.phase !== 'string' || !PUBLICATION_PHASES.has(journal.phase as PublicationPhase)
      || typeof journal.tempPath !== 'string' || typeof journal.backupBase !== 'string'
      || !Array.isArray(journal.plannedSuffixes) || !Array.isArray(journal.movedSuffixes)) {
      throw new Error('SQLite publication journal is invalid');
    }
    const dir = path.dirname(this.dbPath);
    const dbName = path.basename(this.dbPath);
    const exactGenerated = (candidate: string, prefix: string, suffix = '') => {
      const resolved = path.resolve(candidate);
      const base = path.basename(resolved);
      const expectedPrefix = `${dbName}.${prefix}`;
      return path.dirname(resolved) === dir
        && base.startsWith(expectedPrefix)
        && (suffix === '' ? !base.endsWith('-wal') && !base.endsWith('-shm') : base.endsWith(suffix));
    };
    if (!exactGenerated(journal.tempPath, 'rebuild-', '.tmp') || !exactGenerated(journal.backupBase, 'corrupt-')) {
      throw new Error('SQLite publication journal contains an invalid artifact path');
    }
    const plannedSuffixes = journal.plannedSuffixes as unknown[];
    const movedSuffixes = journal.movedSuffixes as unknown[];
    const validSuffix = (suffix: unknown): suffix is DatabaseFileSuffix => DATABASE_FILE_SUFFIXES.includes(suffix as DatabaseFileSuffix);
    if (!plannedSuffixes.every(validSuffix) || !movedSuffixes.every(validSuffix)
      || new Set(plannedSuffixes).size !== plannedSuffixes.length
      || new Set(movedSuffixes).size !== movedSuffixes.length
      || movedSuffixes.some((suffix) => !plannedSuffixes.includes(suffix))) {
      throw new Error('SQLite publication journal contains invalid suffix state');
    }
  }

  private finalizePublicationJournalAfterRelease(journal: PublicationJournal, coordinator: AtomicLockCoordinator, publicationToken: string): void {
    this.assertStillRecoveryOwner();
    if (coordinator.isCurrentOwner(`publication:${this.dbPath}`, publicationToken)) {
      throw new Error(`SQLite publication lease was not released for ${this.displayDbPath}; journal retained`);
    }
    this.assertStillRecoveryOwner();
    fs.rmSync(this.publicationJournalPath(), { force: true });
    this.syncDirectory();
  }

  private publishVerifiedCandidate(result: DatabaseRecoveryResult, verify: () => void, coordinator: AtomicLockCoordinator): void {
    const journal = this.readPublicationJournal();
    if (!journal) throw new Error('SQLite publication journal missing before publication');
    const existingPublication = this.activePublicationLease;
    const publication = existingPublication ? null : this.acquirePublicationLease(coordinator);
    if (publication) this.activePublicationLease = { coordinator, key: `publication:${this.dbPath}`, token: publication.token };
    let verified: PublicationJournal;
    let backupPaths: string[];
    try {
      ({ journal: verified, backupPaths } = this.completePublication(journal, verify, coordinator));
      result.backupPaths = backupPaths;
    } finally {
      if (publication) {
        this.activePublicationLease = null;
        publication.release();
        this.publicationFaultHook?.('after-publication-release-before-journal-delete');
      }
    }
    if (publication) {
      this.finalizePublicationJournalAfterRelease(verified!, coordinator, publication.token);
    }
  }

  private buildAndPublishEmptyDatabase(backupBase: string, cause: unknown, verify: () => void, coordinator: AtomicLockCoordinator): DatabaseRecoveryResult {
    const tempPath = this.rebuildTempPath();
    this.removeDatabaseFileSet(tempPath);
    const target = new (getDatabaseCtor())(tempPath);
    try {
      target.exec('PRAGMA busy_timeout = 5000');
      target.exec('PRAGMA journal_mode = DELETE');
      target.exec('PRAGMA foreign_keys = OFF');
      this.initializeSchema(target);
      this.verifyFinalDatabase(target);
    } finally { this.safeClose(target); }
    for (const suffix of ['-wal', '-shm'] as const) fs.rmSync(`${tempPath}${suffix}`, { force: true });
    const journal: PublicationJournal = { version: 1, canonicalPath: this.dbPath, recoveryToken: this.activeRecoveryLease!.token, phase: 'temp-verified', tempPath, backupBase, plannedSuffixes: this.capturePlannedSuffixes(), movedSuffixes: [] };
    this.writePublicationJournal(journal);
    const result: DatabaseRecoveryResult = { strategy: 'recreated-empty', status: 'degraded', backupPaths: [], error: DatabaseManager.errorMessage(cause ?? 'unknown corruption') };
    this.publishVerifiedCandidate(result, verify, coordinator);
    return result;
  }

  private completePublication(journal: PublicationJournal, verify: () => void, coordinator: AtomicLockCoordinator): { journal: PublicationJournal; backupPaths: string[] } {
    this.validatePublicationJournal(journal);
    let state = journal;
    const inferred = this.inferMovedSuffixes(state, !fs.existsSync(state.tempPath) || state.phase === 'published' || state.phase === 'verified');
    if (state.phase === 'temp-verified' || state.phase === 'prepared' || state.phase === 'quarantine') {
      if (!fs.existsSync(state.tempPath) && !(fs.existsSync(this.dbPath) && inferred.length > 0)) {
        throw new Error('SQLite publication candidate is missing; refusing source quarantine');
      }
      if (fs.existsSync(this.dbPath) && inferred.length > 0) {
        const candidate = new (getDatabaseCtor())(this.dbPath);
        try { this.assertIntegrityOk(candidate, 'integrity_check', 'while reconciling published candidate'); this.assertForeignKeysOk(candidate); }
        finally { this.safeClose(candidate); }
        state = { ...state, phase: 'published', movedSuffixes: inferred };
        this.writePublicationJournal(state);
      } else {
        state = { ...state, phase: state.phase === 'prepared' ? 'prepared' : 'quarantine', movedSuffixes: inferred };
        this.writePublicationJournal(state);
        for (const suffix of state.plannedSuffixes) {
          this.assertStillRecoveryOwner();
          const original = `${this.dbPath}${suffix}`;
          const backup = `${state.backupBase}${suffix}`;
          const originalExists = fs.existsSync(original);
          const backupExists = fs.existsSync(backup);
          if (!originalExists && backupExists) {
            state = { ...state, phase: 'quarantine', movedSuffixes: [...new Set([...state.movedSuffixes, suffix])] };
            this.writePublicationJournal(state);
            continue;
          }
          if (!originalExists && !backupExists) throw new Error(`SQLite publication source suffix is incomplete: ${suffix}`);
          if (originalExists && backupExists) throw new Error(`SQLite publication backup conflict for suffix: ${suffix}`);
          this.publicationFaultHook?.('before-source-rename', suffix);
          coordinator.withCurrentOwner(`recovery:${this.dbPath}`, this.activeRecoveryLease!.token, () => {
            fs.renameSync(original, backup);
            this.syncDirectory();
          });
          this.publicationFaultHook?.('after-source-rename', suffix);
          state = { ...state, phase: 'quarantine', movedSuffixes: [...new Set([...state.movedSuffixes, suffix])] };
          this.writePublicationJournal(state);
        }
      }
      this.assertStillRecoveryOwner();
      if (!fs.existsSync(this.dbPath) && fs.existsSync(state.tempPath)) {
        this.publicationFaultHook?.('before-canonical-rename');
        coordinator.withCurrentOwner(`recovery:${this.dbPath}`, this.activeRecoveryLease!.token, () => {
          fs.renameSync(state.tempPath, this.dbPath);
          this.syncDirectory();
        });
        this.publicationFaultHook?.('after-canonical-rename');
      } else if (!fs.existsSync(this.dbPath)) {
        throw new Error('SQLite publication candidate is missing; refusing empty initialization');
      }
      state = { ...state, phase: 'published', movedSuffixes: this.inferMovedSuffixes(state, true) };
      this.writePublicationJournal(state);
      this.publicationFaultHook?.('after-published-phase');
    }
    this.assertStillRecoveryOwner();
    if (!fs.existsSync(this.dbPath)) throw new Error('SQLite publication candidate is missing; refusing empty initialization');
    const finalDb = this.openUnchecked();
    try { this.verifyFinalDatabase(finalDb); }
    finally { this.safeClose(finalDb); }
    state = { ...state, phase: 'verified', movedSuffixes: this.inferMovedSuffixes(state, true) };
    this.writePublicationJournal(state);
    this.publicationFaultHook?.('after-verified-before-release');
    return { journal: state, backupPaths: state.movedSuffixes.map((suffix) => `${state.backupBase}${suffix}`) };
  }

  private reconcilePublicationJournal(journal: PublicationJournal, verify: () => void, coordinator: AtomicLockCoordinator): DatabaseRecoveryResult {
    const lease = this.activeRecoveryLease;
    if (!lease) throw new Error('SQLite recovery lease missing for publication reconciliation');
    const current = { ...journal, recoveryToken: lease.token };
    this.writePublicationJournal(current);
    const publication = this.acquirePublicationLease(coordinator, true);
    this.activePublicationLease = { coordinator, key: `publication:${this.dbPath}`, token: publication.token };
    let verified: PublicationJournal;
    let backupPaths: string[];
    let result: DatabaseRecoveryResult = { strategy: 'rebuilt', status: 'healthy', backupPaths: [] };
    try {
      try {
        ({ journal: verified, backupPaths } = this.completePublication(current, verify, coordinator));
        result.backupPaths = backupPaths;
      } catch (error) {
        const candidateMissing = error instanceof Error && /candidate is missing|refusing source quarantine|source suffix is incomplete|backup conflict/i.test(error.message);
        let inferred: DatabaseFileSuffix[];
        try {
          inferred = this.inferMovedSuffixes(current, !fs.existsSync(current.tempPath) || current.phase === 'published' || current.phase === 'verified');
        } catch (inferenceError) {
          if (candidateMissing) throw error;
          throw inferenceError;
        }
        const restored = this.canRestoreJournal({ ...current, movedSuffixes: inferred })
          ? this.restoreJournalBackups({ ...current, movedSuffixes: inferred })
          : false;
        if (!restored) {
          if (candidateMissing) throw error;
          result = this.recoverDatabaseFileUnlocked(error, verify, coordinator);
          const retryJournal = this.readPublicationJournal();
          if (!retryJournal) throw new Error('SQLite retry publication journal missing after restore');
          verified = retryJournal;
          backupPaths = result.backupPaths;
        } else {
          verified = this.readPublicationJournal()!;
          backupPaths = [];
          result = { strategy: 'reused', status: 'healthy', backupPaths: [] };
        }
      }
    } finally {
      this.activePublicationLease = null;
      publication.release();
      this.publicationFaultHook?.('after-publication-release-before-journal-delete');
    }
    this.finalizePublicationJournalAfterRelease(verified!, coordinator, publication.token);
    return result;
  }

  private inferMovedSuffixes(journal: PublicationJournal, canonicalMayBePublished = false): DatabaseFileSuffix[] {
    const moved: DatabaseFileSuffix[] = [];
    for (const suffix of journal.plannedSuffixes) {
      const original = fs.existsSync(`${this.dbPath}${suffix}`);
      const backup = fs.existsSync(`${journal.backupBase}${suffix}`);
      if (original && backup && !canonicalMayBePublished) throw new Error(`SQLite publication backup conflict for suffix: ${suffix}`);
      if (!original && !backup) throw new Error(`SQLite publication suffix is missing: ${suffix}`);
      if (backup) moved.push(suffix);
    }
    return moved;
  }

  private canRestoreJournal(journal: PublicationJournal): boolean {
    return journal.plannedSuffixes.length > 0
      && journal.plannedSuffixes.every((suffix) => fs.existsSync(`${journal.backupBase}${suffix}`));
  }

  private restoreJournalBackups(journal: PublicationJournal): boolean {
    const moved = journal.plannedSuffixes.filter((suffix) => fs.existsSync(`${journal.backupBase}${suffix}`));
    if (journal.plannedSuffixes.length === 0 || moved.length !== journal.plannedSuffixes.length) throw new Error('SQLite publication journal has insufficient backups for restore');
    this.assertStillRecoveryOwner();
    for (const suffix of [...moved].reverse()) {
      const backup = `${journal.backupBase}${suffix}`;
      const original = `${this.dbPath}${suffix}`;
      this.assertStillRecoveryOwner();
      this.activeRecoveryLease!.coordinator.withCurrentOwner(`recovery:${this.dbPath}`, this.activeRecoveryLease!.token, () => {
        if (fs.existsSync(original)) fs.rmSync(original, { force: true });
        fs.renameSync(backup, original);
      });
    }
    this.syncDirectory();
    const restored = new (getDatabaseCtor())(this.dbPath);
    let healthy = true;
    try { this.assertIntegrityOk(restored, 'integrity_check', 'after journal rollback'); this.assertForeignKeysOk(restored); }
    catch { healthy = false; }
    finally { this.safeClose(restored); }
    if (healthy) {
      this.assertStillRecoveryOwner();
      this.writePublicationJournal({ ...journal, phase: 'verified', movedSuffixes: [] });
    }
    return healthy;
  }

  private recoverDatabaseFileUnlocked(
    cause: unknown,
    verify: () => void,
    coordinator: AtomicLockCoordinator,
  ): DatabaseRecoveryResult {
    const backupBase = this.corruptBackupBase();
    let rebuildError: unknown;
    let result: DatabaseRecoveryResult;
    if (this.databaseFileSetExists()) {
      try {
        result = this.rebuildDatabaseFromReadableRows(backupBase);
      } catch (err) {
        rebuildError = err;
        // Inventory/policy violations are durable-data incompatibilities, not
        // unreadable SQLite. Never replace such a database with an empty one.
        if (err instanceof Error && /^SQLite recovery blocked by /i.test(err.message)) throw err;
        result = this.buildAndPublishEmptyDatabase(backupBase, rebuildError ?? cause, verify, coordinator);
        return result;
      }
    } else {
      result = this.buildAndPublishEmptyDatabase(backupBase, cause, verify, coordinator);
      return result;
    }
    this.publishVerifiedCandidate(result, verify, coordinator);
    return result;
  }

  private currentDatabaseIsHealthy(): boolean {
    if (!this.hasExistingMainDatabaseFile()) return false;
    let db: DatabaseLike | null = null;
    try {
      db = new (getDatabaseCtor())(this.dbPath);
      this.assertIntegrityOk(db, 'integrity_check', 'while joining explicit corruption recovery');
      this.assertForeignKeysOk(db);
      return true;
    } catch {
      return false;
    } finally {
      if (db) this.safeClose(db);
    }
  }

  private recoveryCircuitPath(): string {
    return `${this.dbPath}.recovery-state.json`;
  }

  private recentRecoveryFailures(): number[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.recoveryCircuitPath(), 'utf-8')) as { failures?: unknown };
      if (!Array.isArray(parsed.failures)) return [];
      const cutoff = Date.now() - Math.max(0, this.recoveryOptions.recoveryCircuitWindowMs);
      return parsed.failures.filter((value): value is number => typeof value === 'number' && value >= cutoff);
    } catch {
      return [];
    }
  }

  private assertRecoveryCircuitClosed(): void {
    if (this.recentRecoveryFailures().length >= Math.max(1, this.recoveryOptions.recoveryCircuitLimit)) {
      throw new Error(
        `SQLite recovery circuit is open for ${this.displayDbPath}: too many failed recovery attempts within ${this.recoveryOptions.recoveryCircuitWindowMs}ms`,
      );
    }
  }

  private recordRecoveryFailure(): void {
    const statePath = this.recoveryCircuitPath();
    const tempPath = `${statePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    const failures = [...this.recentRecoveryFailures(), Date.now()];
    try {
      fs.writeFileSync(tempPath, JSON.stringify({ failures }), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tempPath, statePath);
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  }

  private clearRecoveryFailures(): void {
    fs.rmSync(this.recoveryCircuitPath(), { force: true });
  }

  private clearRecoveryFailuresBestEffort(): void {
    try { this.clearRecoveryFailures(); } catch {}
  }

  private cleanupRecoveryArtifactsBestEffort(): void {
    // Retention cleanup is optional, but it is only best-effort after the
    // durable publication journal has already been finalized.
    if (this.readPublicationJournal()) throw new Error(`SQLite publication journal remains active for ${this.displayDbPath}`);
    try {
      this.cleanupRecoveryArtifacts();
    } catch (error) {
      if (error instanceof Error && /lease lost/i.test(error.message)) throw error;
    }
  }

  private cleanupRecoveryArtifacts(): void {
    this.assertStillRecoveryOwner();
    const activeJournal = this.readPublicationJournal();
    const dir = path.dirname(this.dbPath);
    const databaseName = path.basename(this.dbPath);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const name of names) {
      if (name.startsWith(`${databaseName}.rebuild-`)) {
        if (activeJournal && path.resolve(activeJournal.tempPath) === path.resolve(path.join(dir, name))) continue;
        this.assertStillRecoveryOwner();
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      }
    }

    const backupGroups = new Map<string, number>();
    for (const name of names) {
      if (!name.startsWith(`${databaseName}.corrupt-`)) continue;
      const group = name.replace(/-(?:wal|shm)$/, '');
      try {
        const mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs;
        backupGroups.set(group, Math.max(backupGroups.get(group) ?? 0, mtimeMs));
      } catch {
        // Artifact disappeared while scanning.
      }
    }

    const retained = Math.max(0, this.recoveryOptions.recoveryBackupRetention);
    const expired = [...backupGroups.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(retained);
    for (const [group] of expired) {
      if (activeJournal && path.resolve(activeJournal.backupBase) === path.resolve(group)) continue;
      for (const suffix of DATABASE_FILE_SUFFIXES) {
        this.assertStillRecoveryOwner();
        fs.rmSync(path.join(dir, `${group}${suffix}`), { force: true });
      }
    }
  }

  private static sleepSync(milliseconds: number): void {
    if (milliseconds <= 0) return;
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, milliseconds);
  }

  private rebuildDatabaseFromReadableRows(backupBase: string): DatabaseRecoveryResult {
    const tempPath = this.rebuildTempPath();
    this.removeDatabaseFileSet(tempPath);
    let source: DatabaseLike | null = null;
    let target: DatabaseLike | null = null;
    let recoveredRows: Record<string, number> | undefined;
    let rebuildOk = false;
    try {
      const Database = getDatabaseCtor();
      source = new Database(this.dbPath);
      target = new Database(tempPath);
      target.exec('PRAGMA journal_mode = DELETE');
      target.exec('PRAGMA foreign_keys = OFF');
      this.assertRecoveryInventory(source);
      target.exec(SCHEMA_SQL);
      recoveredRows = this.copyRecoverableRows(source, target);
      this.rebuildFtsTables(target);
      this.verifyFinalDatabase(target);
      rebuildOk = true;
    } finally {
      if (source) this.safeClose(source);
      if (target) this.safeClose(target);
      if (!rebuildOk) this.removeDatabaseFileSet(tempPath);
    }
    this.writePublicationJournal({
      version: 1,
      canonicalPath: this.dbPath,
      recoveryToken: this.activeRecoveryLease!.token,
      phase: 'temp-verified',
      tempPath,
      backupBase,
      plannedSuffixes: this.capturePlannedSuffixes(),
      movedSuffixes: [],
    });
    return { strategy: 'rebuilt', status: 'healthy', backupPaths: [], recoveredRows };
  }

  private copyRecoverableRows(source: DatabaseLike, target: DatabaseLike): Record<string, number> {
    return {
      extension_metadata: this.copyExtensionMetadata(source, target),
      sessions: this.copySessions(source, target),
      messages: this.copyMessages(source, target),
      session_files: this.copySessionFiles(source, target),
      memories: this.copyMemories(source, target),
    };
  }

  private copyExtensionMetadata(source: DatabaseLike, target: DatabaseLike): number {
    const insert = target.prepare('INSERT OR REPLACE INTO extension_metadata (key, value) VALUES (?, ?)');
    let copied = 0;

    for (const row of this.readTableRows(source, 'extension_metadata', ['key', 'value'])) {
      if (typeof row.key !== 'string' || typeof row.value !== 'string') continue;
      insert.run(row.key, row.value);
      copied++;
    }

    return copied;
  }

  private copySessions(source: DatabaseLike, target: DatabaseLike): number {
    const insert = target.prepare(`
      INSERT OR IGNORE INTO sessions (id, project, cwd, started_at, ended_at, message_count, name, title)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let copied = 0;

    for (const row of this.readTableRows(source, 'sessions', ['id', 'project', 'cwd', 'started_at', 'ended_at', 'message_count', 'name', 'title'])) {
      if (typeof row.id !== 'string' || typeof row.cwd !== 'string' || typeof row.started_at !== 'string') continue;
      const project = typeof row.project === 'string' && row.project ? row.project : (path.basename(row.cwd) || 'unknown');
      insert.run(
        row.id,
        project,
        row.cwd,
        row.started_at,
        this.nullableString(row.ended_at),
        this.integerOr(row.message_count, 0),
        this.nullableString(row.name),
        this.nullableString(row.title),
      );
      copied++;
    }

    return copied;
  }

  private copyMessages(source: DatabaseLike, target: DatabaseLike): number {
    const insert = target.prepare(`
      INSERT OR IGNORE INTO messages (id, session_id, entry_id, role, content, timestamp, tool_calls, kind, parent_entry_id, ordinal, tool_name, tool_call_id, diagnostics)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let copied = 0;

    for (const row of this.readTableRows(source, 'messages', ['id', 'session_id', 'entry_id', 'role', 'content', 'timestamp', 'tool_calls', 'kind', 'parent_entry_id', 'parent_id', 'ordinal', 'tool_name', 'tool_call_id', 'diagnostics'])) {
      if (
        typeof row.id !== 'string'
        || typeof row.session_id !== 'string'
        || (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'system')
        || typeof row.content !== 'string'
        || typeof row.timestamp !== 'string'
      ) {
        continue;
      }

      const entryId = typeof row.entry_id === 'string' && row.entry_id ? row.entry_id : (typeof row.id === 'string' && !row.id.startsWith('idx:v1:') ? row.id : null);
      const storageId = typeof row.id === 'string' && row.id.startsWith('idx:v1:')
        ? row.id
        : `idx:v1:${createHash('sha256').update(JSON.stringify({ v: 1, sessionId: row.session_id, oldId: row.id })).digest('hex').slice(0, 32)}`;
      const canonicalParent = typeof row.parent_entry_id === 'string' && row.parent_entry_id !== '' ? row.parent_entry_id : null;
      const legacyParent = typeof row.parent_id === 'string' && row.parent_id !== '' ? row.parent_id : null;
      const diagnostic = canonicalParent && legacyParent && canonicalParent !== legacyParent
        ? appendDiagnostic(row.diagnostics, 'legacy-parent-conflict')
        : this.nullableString(row.diagnostics);
      insert.run(storageId, row.session_id, entryId, row.role, row.content, row.timestamp, this.nullableString(row.tool_calls), typeof row.kind === 'string' ? row.kind : 'message', canonicalParent ?? legacyParent, this.integerOr(row.ordinal, 0), this.nullableString(row.tool_name), this.nullableString(row.tool_call_id), diagnostic);
      copied++;
    }

    return copied;
  }

  private copySessionFiles(source: DatabaseLike, target: DatabaseLike): number {
    const insert = target.prepare(`
      INSERT OR IGNORE INTO session_files (path, session_id, size, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    let copied = 0;

    for (const row of this.readTableRows(source, 'session_files', ['path', 'session_id', 'size', 'mtime_ms', 'indexed_at'])) {
      if (typeof row.path !== 'string' || typeof row.session_id !== 'string') continue;
      insert.run(
        row.path,
        row.session_id,
        this.integerOr(row.size, 0),
        this.integerOr(row.mtime_ms, 0),
        typeof row.indexed_at === 'string' ? row.indexed_at : new Date(0).toISOString(),
      );
      copied++;
    }

    return copied;
  }

  private copyMemories(source: DatabaseLike, target: DatabaseLike): number {
    const insert = target.prepare(`
      INSERT OR IGNORE INTO memories (id, project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let copied = 0;

    for (const row of this.readTableRows(source, 'memories', [
      'id',
      'project',
      'target',
      'category',
      'content',
      'failure_reason',
      'tool_state',
      'corrected_to',
      'created',
      'last_referenced',
    ])) {
      const id = this.integerOr(row.id, NaN);
      if (!Number.isFinite(id) || typeof row.content !== 'string') continue;

      const targetName = typeof row.target === 'string' && MEMORY_TARGETS.has(row.target) ? row.target : 'memory';
      const category = typeof row.category === 'string' && MEMORY_CATEGORIES.has(row.category) ? row.category : null;
      const created = typeof row.created === 'string' ? row.created : new Date(0).toISOString();
      const lastReferenced = typeof row.last_referenced === 'string' ? row.last_referenced : created;

      insert.run(
        id,
        this.nullableString(row.project),
        targetName,
        category,
        row.content,
        this.nullableString(row.failure_reason),
        this.nullableString(row.tool_state),
        this.nullableString(row.corrected_to),
        created,
        lastReferenced,
      );
      copied++;
    }

    return copied;
  }

  /** Fail closed before recovery copy if durable state is outside this phase's contract. */
  public assertRecoveryInventory(source: DatabaseLike): void {
    const allowed: Record<string, Set<string>> = {
      extension_metadata: new Set(['key', 'value']),
      sessions: new Set(['id', 'project', 'cwd', 'started_at', 'ended_at', 'message_count', 'name', 'title']),
      session_files: new Set(['path', 'session_id', 'size', 'mtime_ms', 'indexed_at']),
      messages: new Set(['id', 'session_id', 'entry_id', 'role', 'content', 'timestamp', 'tool_calls', 'kind', 'parent_entry_id', 'parent_id', 'ordinal', 'tool_name', 'tool_call_id', 'diagnostics']),
      memories: new Set(['id', 'project', 'target', 'category', 'content', 'failure_reason', 'tool_state', 'corrected_to', 'created', 'last_referenced']),
    };
    const tables = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name?: unknown }>;
    for (const row of tables) {
      const table = row.name;
      if (typeof table !== 'string') continue;
      if (KNOWN_FTS_TABLES.has(table)) continue;
      const expected = allowed[table];
      if (!expected) throw new Error(`SQLite recovery blocked by unknown durable table: ${table}`);
      for (const column of this.getColumnNames(source, table)) {
        if (!expected.has(column)) {
          if (table === 'memories' && ['evidence_session_id', 'evidence_entry_id', 'evidence_anchor', 'evidence_timestamp'].includes(column)) {
            const nonEmpty = source.prepare(`SELECT 1 FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IS NOT NULL AND ${quoteIdentifier(column)} <> '' LIMIT 1`).get();
            if (nonEmpty) throw new Error(`SQLite recovery blocked by non-empty excluded provenance column: memories.${column}; clear the legacy value before opening`);
            continue;
          }
          throw new Error(`SQLite recovery blocked by unknown durable column: ${table}.${column}`);
        }
      }
    }
  }

  private readTableRows(source: DatabaseLike, table: string, desiredColumns: string[]): Iterable<Record<string, unknown>> {
    const columns = this.getColumnNames(source, table);
    const selected = desiredColumns.filter((column) => columns.has(column));
    if (selected.length === 0) return [];

    const sql = `SELECT ${selected.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)} NOT INDEXED`;
    const statement = source.prepare(sql);
    const rows = statement.iterate
      ? statement.iterate() as Iterable<Record<string, unknown>>
      : statement.all() as Record<string, unknown>[];
    const manager = this;
    return (function* (): Iterable<Record<string, unknown>> {
      for (const row of rows) {
        manager.renewRecoveryLease();
        yield row;
      }
    })();
  }

  private getColumnNames(db: DatabaseLike, table: string): Set<string> {
    const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as { name?: unknown }[];
    return new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === 'string'));
  }

  private nullableString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private integerOr(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
  }

  private rebuildFtsTables(db: DatabaseLike): void {
    db.exec("INSERT INTO message_fts(message_fts) VALUES('rebuild')");
    db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
  }

  private capturePlannedSuffixes(): DatabaseFileSuffix[] {
    return DATABASE_FILE_SUFFIXES.filter((suffix) => fs.existsSync(`${this.dbPath}${suffix}`));
  }

  private corruptBackupBase(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const nonce = Math.random().toString(16).slice(2, 8);
    return `${this.dbPath}.corrupt-${stamp}-${process.pid}-${nonce}`;
  }

  private rebuildTempPath(): string {
    const stamp = Date.now();
    const nonce = Math.random().toString(16).slice(2, 8);
    return `${this.dbPath}.rebuild-${process.pid}-${stamp}-${nonce}.tmp`;
  }

  /**
   * Verifies this instance still holds the recovery lease immediately before
   * a destructive rename that has no independent compare-and-swap of its
   * own (unlike the Markdown mutation path, which re-checks a content
   * fingerprint at publish time). If the lease was reclaimed as stale while
   * this call was in flight, abort rather than race the new owner.
   */
  private acquirePublicationLease(coordinator: AtomicLockCoordinator, reconciliation = false): { token: string; release: () => void; renew: () => boolean } {
    const key = `publication:${this.dbPath}`;
    const deadline = Date.now() + this.recoveryOptions.recoveryLockWaitMs;
    const recoveryToken = this.activeRecoveryLease?.token;
    if (!recoveryToken) throw new Error(`SQLite recovery lease missing for ${this.displayDbPath}; publication aborted`);
    let lease = coordinator.acquirePublication(this.dbPath, recoveryToken, { staleMs: 0 });
    if (!lease && reconciliation) {
      // The recovery row was acquired with dead-publication reconciliation; the
      // publication row is removed atomically by that acquisition.
      lease = coordinator.acquirePublication(this.dbPath, recoveryToken, { staleMs: 0 });
    }
    while (!lease && Date.now() < deadline) { DatabaseManager.sleepSync(this.recoveryOptions.recoveryLockPollMs); lease = coordinator.acquirePublication(this.dbPath, recoveryToken, { staleMs: 0 }); }
    if (!lease) throw new Error(`SQLite publication barrier timed out for ${this.displayDbPath}`);
    if (!this.activeRecoveryLease || !coordinator.isCurrentOwner(this.activeRecoveryLease.key, this.activeRecoveryLease.token)) {
      lease.release();
      throw new Error(`SQLite recovery lease lost for ${this.displayDbPath}; publication aborted`);
    }
    return lease;
  }

  private renewRecoveryLease(): void {
    const active = this.activeRecoveryLease;
    if (active && !active.coordinator.renew(active.key, active.token)) {
      throw new Error(`SQLite recovery lease lost for ${this.displayDbPath}; another process took over`);
    }
    const publication = this.activePublicationLease;
    if (publication && !publication.coordinator.renew(publication.key, publication.token)) {
      throw new Error(`SQLite publication lease lost for ${this.displayDbPath}; another process took over`);
    }
  }

  private assertStillRecoveryOwner(): void {
    this.renewRecoveryLease();
  }

  private removeDatabaseFileSet(basePath: string): void {
    for (const suffix of DATABASE_FILE_SUFFIXES) {
      this.assertStillRecoveryOwner();
      fs.rmSync(`${basePath}${suffix}`, { force: true });
    }
  }

  private safeClose(db: DatabaseLike): void {
    try { db.close(); } catch { /* best effort */ }
  }

  private isLegacySchemaError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes('no such column: category')
      || msg.includes('memories(category)')
      || msg.includes('no such column: project')
      || msg.includes('sessions(project)')
      || msg.includes('messages(entry_id)')
      || (msg.includes('no such column') && msg.includes('entry_id'))
      || msg.includes('memories(project)');
  }

  private ensureLegacySchemaColumns(db: DatabaseLike): void {
    this.ensureMemoriesColumns(db);
    this.ensureSessionsColumns(db);
  }

  private ensureSessionEntryColumns(db: DatabaseLike): void {
    const sessionExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get();
    if (sessionExists) {
      const names = this.getColumnNames(db, 'sessions');
      if (!names.has('name')) db.exec('ALTER TABLE sessions ADD COLUMN name TEXT');
      if (!names.has('title')) db.exec('ALTER TABLE sessions ADD COLUMN title TEXT');
    }

    const messageExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get();
    if (!messageExists) return;
    const names = this.getColumnNames(db, 'messages');
    const columns: Array<[string, string]> = [
      ['entry_id', 'TEXT'],
      ['kind', "TEXT NOT NULL DEFAULT 'message'"],
      ['parent_entry_id', 'TEXT'],
      ['ordinal', 'INTEGER NOT NULL DEFAULT 0'],
      ['tool_name', 'TEXT'],
      ['tool_call_id', 'TEXT'],
      ['diagnostics', 'TEXT'],
    ];
    for (const [name, definition] of columns) {
      if (!names.has(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${quoteIdentifier(name)} ${definition}`);
    }
  }

  private repairSessionEntries(db: DatabaseLike): void {
    const names = this.getColumnNames(db, 'messages');
    if (!names.has('entry_id') || !names.has('ordinal')) return;
    const hasLegacyParent = names.has('parent_id');
    const hasToolCallId = names.has('tool_call_id');
    const rows = db.prepare(`SELECT rowid, id, session_id, entry_id, ordinal, parent_entry_id${hasLegacyParent ? ', parent_id' : ''}${hasToolCallId ? ', tool_call_id' : ''}, diagnostics FROM messages ORDER BY rowid`).all() as Array<Record<string, unknown>>;
    const work = () => {
      // Keep trigger removal inside the repair transaction: a crash rolls it
      // back, while the complete external-content FTS rebuild follows commit.
      db.exec('DROP TRIGGER IF EXISTS messages_ai; DROP TRIGGER IF EXISTS messages_ad; DROP TRIGGER IF EXISTS messages_au;');
      const update = db.prepare('UPDATE messages SET id = ?, entry_id = ?, ordinal = ?, parent_entry_id = ?, tool_call_id = ?, diagnostics = ? WHERE rowid = ?');
      for (const row of rows) {
        const oldId = typeof row.id === 'string' ? row.id : '';
        const sessionId = typeof row.session_id === 'string' ? row.session_id : '';
        const entryId = typeof row.entry_id === 'string' && row.entry_id ? row.entry_id : oldId || null;
        const storageId = oldId.startsWith('idx:v1:') ? oldId : `idx:v1:${createHash('sha256').update(JSON.stringify({ v: 1, sessionId, oldId, rowid: row.rowid })).digest('hex').slice(0, 32)}`;
        const ordinal = typeof row.ordinal === 'number' && row.ordinal > 0 ? Math.trunc(row.ordinal) : Number(row.rowid) - 1;
        const canonicalParent = typeof row.parent_entry_id === 'string' && row.parent_entry_id !== '' ? row.parent_entry_id : null;
        const legacyParent = typeof row.parent_id === 'string' && row.parent_id !== '' ? row.parent_id : null;
        let diagnostic: string | null = typeof row.diagnostics === 'string' ? row.diagnostics : null;
        if (legacyParent && canonicalParent && legacyParent !== canonicalParent) diagnostic = appendDiagnostic(diagnostic, 'legacy-parent-conflict');
        update.run(storageId, entryId, ordinal, canonicalParent ?? legacyParent, hasToolCallId ? this.nullableString(row.tool_call_id) : null, diagnostic, row.rowid);
      }
      const duplicates = db.prepare(`
        SELECT session_id, entry_id FROM messages
        WHERE entry_id IS NOT NULL
        GROUP BY session_id, entry_id HAVING COUNT(*) > 1
      `).all() as Array<{ session_id: string; entry_id: string }>;
      const clear = db.prepare('UPDATE messages SET entry_id = NULL, diagnostics = ? WHERE session_id = ? AND entry_id = ?');
      for (const duplicate of duplicates) clear.run('ambiguous-entry-id', duplicate.session_id, duplicate.entry_id);
    };
    if (db.transaction) db.transaction(work)();
    else { db.exec('BEGIN IMMEDIATE'); try { work(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } }
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        UPDATE messages SET entry_id = COALESCE(new.entry_id, new.id) WHERE rowid = new.rowid AND entry_id IS NULL;
        INSERT INTO message_fts(rowid, content) SELECT rowid, content FROM messages WHERE rowid = new.rowid;
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO message_fts(message_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages
      WHEN old.content IS NOT new.content BEGIN
        INSERT INTO message_fts(message_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO message_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);
  }

  private rebuildMessageFts(db: DatabaseLike): void {
    const ftsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_fts'").get() as { name?: string } | undefined;
    if (ftsTable) db.exec("INSERT INTO message_fts(message_fts) VALUES('rebuild')");
  }

  private ensureMemoriesColumns(db: DatabaseLike): void {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").get() as { name: string } | undefined;
    if (!tableExists) return;

    const names = this.getColumnNames(db, 'memories');

    if (!names.has('project')) {
      db.exec('ALTER TABLE memories ADD COLUMN project TEXT');
    }
    if (!names.has('category')) {
      db.exec('ALTER TABLE memories ADD COLUMN category TEXT');
    }
    if (!names.has('failure_reason')) {
      db.exec('ALTER TABLE memories ADD COLUMN failure_reason TEXT');
    }
    if (!names.has('tool_state')) {
      db.exec('ALTER TABLE memories ADD COLUMN tool_state TEXT');
    }
    if (!names.has('corrected_to')) {
      db.exec('ALTER TABLE memories ADD COLUMN corrected_to TEXT');
    }
  }

  private ensureSessionsColumns(db: DatabaseLike): void {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get() as { name: string } | undefined;
    if (!tableExists) return;

    const names = this.getColumnNames(db, 'sessions');
    if (!names.has('project')) {
      db.exec('ALTER TABLE sessions ADD COLUMN project TEXT');
    }

    // Project is derived enrichment. Probe only a bounded prefix so legacy
    // migration keeps small databases compatible without an O(N) COUNT scan.
    const hasSessions = db.prepare('SELECT 1 FROM sessions LIMIT 1').get();
    if (!hasSessions) return;
    const rows = db.prepare('SELECT id, cwd, project FROM sessions LIMIT 1001').all() as Array<{
      id?: unknown;
      cwd?: unknown;
      project?: unknown;
    }>;
    if (rows.length <= 1_000) this.backfillSessionsProject(db, rows);
  }

  private backfillSessionsProject(
    db: DatabaseLike,
    rows: Array<{ id?: unknown; cwd?: unknown; project?: unknown }>,
  ): void {
    const names = this.getColumnNames(db, 'sessions');
    if (!names.has('project') || !names.has('cwd') || !names.has('id')) return;

    const update = db.prepare('UPDATE sessions SET project = ? WHERE id = ?');
    for (const row of rows) {
      if (typeof row.id !== 'string') continue;
      if (typeof row.project === 'string' && row.project.trim()) continue;

      const project = typeof row.cwd === 'string' && row.cwd.trim()
        ? (path.basename(row.cwd) || 'unknown')
        : 'unknown';
      update.run(project, row.id);
    }
  }

  private migrateLegacyMemoriesTargetConstraint(db: DatabaseLike): void {
    const tableSqlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'").get() as { sql?: string } | undefined;
    const tableSql = tableSqlRow?.sql ?? '';
    if (!tableSql) return;

    // Legacy schema allowed only memory/user. New schema must allow failure too.
    const hasLegacyTargetCheck = /target\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*target\s+IN\s*\(\s*'memory'\s*,\s*'user'\s*\)\s*\)/i.test(tableSql);
    if (!hasLegacyTargetCheck) return;

    if (!db.transaction) {
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.exec('BEGIN IMMEDIATE');
        db.exec(`
          CREATE TABLE memories_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT,
            target TEXT NOT NULL CHECK (target IN ('memory', 'user', 'failure')),
            category TEXT CHECK (category IN ('failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk')),
            content TEXT NOT NULL,
            failure_reason TEXT,
            tool_state TEXT,
            corrected_to TEXT,
            created DATE NOT NULL,
            last_referenced DATE NOT NULL
          );
        `);

        db.exec(`
          INSERT INTO memories_new (id, project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
          SELECT id, project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced
          FROM memories;
        `);

        db.exec('DROP TABLE memories');
        db.exec('ALTER TABLE memories_new RENAME TO memories');
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
      return;
    }

    const tx = db.transaction(() => {
      db.exec(`
        CREATE TABLE memories_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT,
          target TEXT NOT NULL CHECK (target IN ('memory', 'user', 'failure')),
          category TEXT CHECK (category IN ('failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk')),
          content TEXT NOT NULL,
          failure_reason TEXT,
          tool_state TEXT,
          corrected_to TEXT,
          created DATE NOT NULL,
          last_referenced DATE NOT NULL
        );
      `);

      db.exec(`
          INSERT INTO memories_new (id, project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
          SELECT id, project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced
          FROM memories;
        `);

      db.exec('DROP TABLE memories');
      db.exec('ALTER TABLE memories_new RENAME TO memories');
    });

    db.exec('PRAGMA foreign_keys = OFF');
    try {
      tx();
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  private rebuildMemoryFts(db: DatabaseLike): void {
    const ftsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'").get() as { name?: string } | undefined;
    if (!ftsTable) return;

    // Keep FTS index consistent after table rebuild/migrations.
    db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
  }

  /**
   * Close the database connection.
   */
  close(keepFacade = false): boolean {
    this.facade?.resetAfterManagerClose();
    if (this.mutationLeaseDepth > 0) {
      try { this.native?.exec('ROLLBACK'); } catch {}
      this.mutationLeaseDepth = 0;
      this.mutationLease?.release();
      this.mutationLease = null;
    }
    const native = this.native;
    if (native) {
      const coordinator = AtomicLockCoordinator.shared(path.join(path.dirname(this.dbPath), '.pi-hermes-locks.sqlite'));
      const deadline = Date.now() + this.recoveryOptions.recoveryLockWaitMs;
      let barrier = this.activeRecoveryLease ? null : coordinator.acquireRecovery(this.dbPath, { staleMs: 0 });
      while (!this.activeRecoveryLease && !barrier && Date.now() < deadline) {
        DatabaseManager.sleepSync(this.recoveryOptions.recoveryLockPollMs);
        barrier = coordinator.acquireRecovery(this.dbPath, { staleMs: 0 });
      }
      if (!this.activeRecoveryLease && !barrier) return false;
      try {
        try { native.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
      } finally {
        barrier?.release();
        try { native.close(); } catch {}
      }
    }
    this.native = null;
    this.db = null;
    if (!keepFacade) this.facade = null;
    this.generation = null;
    return true;
  }

  /**
   * Get the database file path.
   */
  getPath(): string {
    return this.displayDbPath;
  }

  /**
   * Check if the database file exists.
   */
  exists(): boolean {
    return fs.existsSync(this.dbPath);
  }

  /**
   * Get stats about the database.
   */
  getStats(): { sessions: number; messages: number; memories: number } {
    const db = this.getDb();
    const sessions = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
    const messages = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
    const memories = db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number };
    return {
      sessions: sessions.count,
      messages: messages.count,
      memories: memories.count,
    };
  }
}
