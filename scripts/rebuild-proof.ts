#!/usr/bin/env -S npx tsx

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type RunnerOutcome = 'PASS' | 'BLOCKED';

export interface RunnerArgs {
  agentRoot: string;
  sessionsDir: string;
  globalDir: string;
  projectsMemoryDir: string;
  expectedManifest?: string;
  receipt: string;
  maxWallMs: number;
  termGraceMs: number;
  worker?: boolean;
}

interface ManifestFile {
  path: string;
  type?: string;
  size?: number;
  mtimeMs?: number;
  sha256?: string;
}

interface ManifestDocument {
  files?: ManifestFile[] | Record<string, Omit<ManifestFile, 'path'>>;
  expected?: Record<string, number>;
  counts?: Record<string, number>;
  [key: string]: unknown;
}

interface Receipt {
  schema: 'pi-hermes-memory.rebuild-proof.receipt.v1';
  outcome: RunnerOutcome;
  reason?: string;
  source: { commitSha?: string; repository: string };
  runner: { commitSha?: string; path: string };
  dependencies: { packageLockSha256?: string; node: string; abi: string; platform: string; arch: string };
  paths: { agentRoot: string; sessionsDir: string; globalDir: string; projectsMemoryDir: string; database: string };
  counts: Record<string, number>;
  warnings: string[];
  errors: string[];
  supervision: { maxWallMs: number; termGraceMs: number; timedOut: boolean; descendants: number; openFds: number };
  metadataOnly: true;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_MAX_WALL_MS = 120 * 60 * 1000;
const DEFAULT_TERM_GRACE_MS = 30 * 1000;

function fail(message: string): never {
  throw new Error(message);
}

function parsePositiveInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${name} must be a positive integer`);
  return parsed;
}

function parseDuration(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const match = value.trim().match(/^(\\d+)(ms|s|m|h)?$/i);
  if (!match) fail(`${name} must be a duration such as 500ms, 30s, or 120m`);
  const amount = Number(match[1]);
  const multiplier = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(match[2] ?? 'ms').toLowerCase() as 'ms' | 's' | 'm' | 'h'];
  const parsed = amount * multiplier;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${name} must be a positive duration`);
  return parsed;
}

export function parseArgs(argv: string[], env = process.env): RunnerArgs {
  const values = new Map<string, string>();
  let worker = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--worker') { worker = true; continue; }
    if (!arg.startsWith('--')) fail(`unknown argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[++i];
    if (!value || value.startsWith('--')) fail(`missing value for --${key}`);
    values.set(key, value);
  }
  const required = (name: string): string => values.get(name) ?? fail(`--${name} is required`);
  const maxWallMs = parsePositiveInt(values.get('max-wall-ms'), 'max wall', parseDuration(env.REBUILD_MAX_WALL ?? env.REBUILD_MAX_WALL_MS, 'REBUILD_MAX_WALL', DEFAULT_MAX_WALL_MS));
  const termGraceMs = parsePositiveInt(values.get('term-grace-ms'), 'term grace', parseDuration(env.REBUILD_TERM_GRACE ?? env.REBUILD_TERM_GRACE_MS, 'REBUILD_TERM_GRACE', DEFAULT_TERM_GRACE_MS));
  return {
    agentRoot: path.resolve(required('agent-root')),
    sessionsDir: path.resolve(required('sessions-dir')),
    globalDir: path.resolve(required('global-dir')),
    projectsMemoryDir: path.resolve(required('projects-memory-dir')),
    expectedManifest: values.get('expected-manifest'),
    receipt: path.resolve(required('receipt')),
    maxWallMs,
    termGraceMs,
    worker,
  };
}

function canonicalExisting(p: string, label: string): string {
  if (!existsSync(p)) fail(`${label} does not exist`);
  return realpathSync(p);
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function liveRoots(): string[] {
  const roots = [
    process.env.PI_HERMES_LIVE_AGENT_ROOT,
    process.env.PI_CODING_AGENT_LIVE_ROOT,
    process.env.PI_HERMES_LIVE_VAULT_ROOT,
    process.env.OBSIDIAN_VAULT_ROOT,
    process.env.HOME ? path.join(process.env.HOME, '.pi', 'agent') : undefined,
  ].filter((value): value is string => Boolean(value));
  return roots.map((root) => path.resolve(root));
}

export function validateBindings(args: RunnerArgs, env = process.env): { agentRoot: string; sessionsDir: string; globalDir: string; projectsMemoryDir: string } {
  const boundAgent = env.PI_CODING_AGENT_DIR?.trim();
  const boundSessions = env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (!boundAgent || !boundSessions) fail('PI_CODING_AGENT_DIR and PI_CODING_AGENT_SESSION_DIR must be explicit');

  const agentRoot = canonicalExisting(args.agentRoot, 'agent root');
  const sessionsDir = canonicalExisting(args.sessionsDir, 'sessions dir');
  const globalDir = canonicalExisting(args.globalDir, 'global memory dir');
  const projectsMemoryDir = canonicalExisting(args.projectsMemoryDir, 'projects memory dir');
  const envAgent = path.resolve(boundAgent);
  const envSessions = path.resolve(boundSessions);
  if (envAgent !== agentRoot || envSessions !== sessionsDir) fail('environment bindings do not match CLI staging paths');
  if (globalDir !== path.join(agentRoot, 'pi-hermes-memory')) fail('global memory dir must be <agent>/pi-hermes-memory');
  if (projectsMemoryDir !== path.join(agentRoot, 'projects-memory')) fail('projects memory dir must be <agent>/projects-memory');
  if (sessionsDir !== path.join(agentRoot, 'sessions')) fail('sessions dir must be <agent>/sessions');
  if (!contained(agentRoot, sessionsDir) || !contained(agentRoot, globalDir) || !contained(agentRoot, projectsMemoryDir)) {
    fail('all staging roots must be contained by --agent-root');
  }
  for (const root of liveRoots()) {
    const canonicalLive = existsSync(root) ? realpathSync(root) : path.resolve(root);
    if (contained(canonicalLive, agentRoot) || contained(agentRoot, canonicalLive)) fail('staging roots overlap a live vault or agent root');
  }
  return { agentRoot, sessionsDir, globalDir, projectsMemoryDir };
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function filesUnder(root: string, predicate?: (filePath: string) => boolean): Promise<string[]> {
  const result: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && (!predicate || predicate(full))) result.push(full);
    }
  }
  await walk(root);
  return result.sort();
}

async function loadManifest(filePath: string | undefined): Promise<ManifestDocument | null> {
  if (!filePath) return null;
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as ManifestDocument;
  if (!raw || typeof raw !== 'object') fail('expected manifest must be a JSON object');
  return raw;
}

function manifestEntries(manifest: ManifestDocument | null): ManifestFile[] {
  if (!manifest?.files) return [];
  if (Array.isArray(manifest.files)) return manifest.files;
  return Object.entries(manifest.files).map(([filePath, metadata]) => ({ path: filePath, ...metadata }));
}

async function compareManifest(manifest: ManifestDocument | null, roots: string[], agentRoot: string): Promise<{ warnings: string[]; counts: Record<string, number> }> {
  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  if (!manifest) return { warnings, counts };
  const expected = manifestEntries(manifest);
  const actual: ManifestFile[] = [];
  for (const root of roots) {
    for (const filePath of await filesUnder(root)) {
      const metadata = await stat(filePath);
      actual.push({ path: filePath, type: 'file', size: metadata.size, mtimeMs: Math.trunc(metadata.mtimeMs), sha256: await sha256(filePath) });
    }
  }
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  for (const entry of expected) {
    const absolute = path.isAbsolute(entry.path) ? path.resolve(entry.path) : path.resolve(agentRoot, entry.path);
    const found = actualByPath.get(absolute) ?? actualByPath.get(entry.path);
    if (!found) fail(`expected manifest file missing: ${entry.path}`);
    if (entry.size !== undefined && entry.size !== found.size) fail(`expected manifest size mismatch: ${entry.path}`);
    if (entry.mtimeMs !== undefined && Math.trunc(entry.mtimeMs) !== found.mtimeMs) fail(`expected manifest mtime mismatch: ${entry.path}`);
    if (entry.sha256 !== undefined && entry.sha256 !== found.sha256) fail(`expected manifest hash mismatch: ${entry.path}`);
  }
  if (expected.length && actual.length !== expected.length) fail('expected manifest file count mismatch');
  counts.manifestFiles = actual.length;
  return { warnings, counts };
}

function expectedCount(manifest: ManifestDocument | null, names: string[]): number | undefined {
  for (const source of [manifest?.expected, manifest?.counts, manifest]) {
    if (!source) continue;
    for (const name of names) if (typeof source[name] === 'number') return source[name];
  }
  return undefined;
}

async function worker(args: RunnerArgs): Promise<Receipt> {
  const counts: Record<string, number> = {};
  const warnings: string[] = [];
  const errors: string[] = [];
  const base = {
    schema: 'pi-hermes-memory.rebuild-proof.receipt.v1' as const,
    outcome: 'BLOCKED' as RunnerOutcome,
    source: { repository: process.cwd() },
    runner: { path: SCRIPT_PATH },
    dependencies: { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch },
    paths: { agentRoot: args.agentRoot, sessionsDir: args.sessionsDir, globalDir: args.globalDir, projectsMemoryDir: args.projectsMemoryDir, database: path.join(args.globalDir, 'sessions.db') },
    counts,
    warnings,
    errors,
    supervision: { maxWallMs: args.maxWallMs, termGraceMs: args.termGraceMs, timedOut: false, descendants: 0, openFds: 0 },
    metadataOnly: true as const,
  };
  try {
    // This must remain before every Hermes import and before DatabaseManager construction.
    const paths = validateBindings(args);
    const testSleepMs = parsePositiveInt(process.env.REBUILD_TEST_SLEEP_MS, 'test sleep', 0);
    if (testSleepMs > 0) await new Promise((resolve) => setTimeout(resolve, testSleepMs));
    const manifest = await loadManifest(args.expectedManifest);
    const manifestResult = await compareManifest(manifest, [paths.sessionsDir, paths.globalDir, paths.projectsMemoryDir], paths.agentRoot);
    Object.assign(counts, manifestResult.counts);
    const lockPath = path.join(process.cwd(), 'package-lock.json');
    if (existsSync(lockPath)) base.dependencies.packageLockSha256 = await sha256(lockPath);
    const head = await gitValue('rev-parse', 'HEAD');
    if (head) { base.source.commitSha = head; base.runner.commitSha = head; }

    // No static Hermes imports: these are intentionally resolved only after all fencing.
    const { DatabaseManager } = await import('../src/store/db.js');
    const { syncMarkdownMemoriesToSqlite } = await import('../src/handlers/sync-markdown-memories.js');
    const { indexAllSessions } = await import('../src/store/session-indexer.js');
    const db = new DatabaseManager(paths.globalDir);
    try {
      const memory = await syncMarkdownMemoriesToSqlite(db, paths.globalDir, paths.projectsMemoryDir, paths.agentRoot);
      const sessions = indexAllSessions(db, paths.sessionsDir);
      Object.assign(counts, {
        filesScanned: memory.filesScanned,
        entriesScanned: memory.entriesScanned,
        imported: memory.imported,
        skipped: memory.skipped,
        removed: memory.removed,
        projects: memory.projectCount,
        sessionsProcessed: sessions.sessionsProcessed,
        sessionsIndexed: sessions.sessionsIndexed,
        sessionsSkipped: sessions.sessionsSkipped,
        messagesIndexed: sessions.messagesIndexed,
        sessions: Number((db.getDb().prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }).count),
        messages: Number((db.getDb().prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }).count),
        memories: Number((db.getDb().prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count),
      });
      warnings.push(...memory.warnings);
      errors.push(...sessions.errors);
      const quick = db.getDb().prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
      if (String(Object.values(quick[0] ?? {})[0] ?? '').toLowerCase() !== 'ok') errors.push('SQLite quick_check failed');
      db.getDb().prepare('SELECT rowid FROM message_fts LIMIT 1').all();
      db.getDb().prepare('SELECT rowid FROM memory_fts LIMIT 1').all();
      for (const [name, aliases] of Object.entries({ sessions: ['sessions', 'expectedSessions'], messages: ['messages', 'expectedMessages'], memories: ['memories', 'expectedMemories'] })) {
        const expected = expectedCount(manifest, aliases);
        if (expected !== undefined && counts[name] !== expected) errors.push(`${name} count mismatch`);
      }
      if (warnings.length || errors.length) base.reason = 'warnings or errors prevent a proof PASS';
      else base.outcome = 'PASS';
    } finally {
      db.close();
    }
  } catch (error) {
    base.reason = error instanceof Error ? error.message : String(error);
    errors.push(base.reason);
  }
  return base;
}

async function gitValue(...args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.on('close', (code) => resolve(code === 0 ? output.trim() : undefined));
  });
}

function descendantsOf(pid: number): number[] {
  const parent = new Map<number, number>();
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const status = readFileSync(`/proc/${name}/status`, 'utf8');
        if (/^State:\s+Z/m.test(status)) continue;
        const match = status.match(/^PPid:\s+(\d+)/m);
        if (match) parent.set(Number(name), Number(match[1]));
      } catch { /* process exited */ }
    }
  } catch { return []; }
  const result: number[] = [];
  let changed = true;
  const seen = new Set<number>([pid]);
  while (changed) {
    changed = false;
    for (const [child, ppid] of parent) {
      if (seen.has(ppid) && !seen.has(child)) { seen.add(child); result.push(child); changed = true; }
    }
  }
  return result;
}

function livePids(pids: number[]): number[] {
  return pids.filter((pid) => {
    try { return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, 'utf8')); }
    catch { return false; }
  });
}

function openFdCount(pids: number[]): number {
  let count = 0;
  for (const pid of pids) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      if (/^State:\s+Z/m.test(status)) continue;
      count += readdirSync(`/proc/${pid}/fd`).length;
    } catch { /* process exited */ }
  }
  return count;
}

async function supervise(args: RunnerArgs): Promise<Receipt> {
  await mkdir(path.dirname(args.receipt), { recursive: true });
  const childArgs = ['--import', 'tsx', SCRIPT_PATH, '--worker', '--agent-root', args.agentRoot, '--sessions-dir', args.sessionsDir, '--global-dir', args.globalDir, '--projects-memory-dir', args.projectsMemoryDir, '--receipt', args.receipt];
  if (args.expectedManifest) childArgs.push('--expected-manifest', args.expectedManifest);
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, PI_CODING_AGENT_DIR: args.agentRoot, PI_CODING_AGENT_SESSION_DIR: args.sessionsDir },
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const started = Date.now();
  let timedOut = false;
  const exit = await new Promise<{ code: number | null }>((resolve) => {
    let settled = false;
    const finish = (code: number | null) => { if (!settled) { settled = true; resolve({ code }); } };
    child.once('close', (code) => finish(code));
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } }, args.termGraceMs).unref();
      setTimeout(() => finish(null), args.termGraceMs + 250).unref();
    }, args.maxWallMs);
    child.once('close', () => clearTimeout(timer));
  });
  const pids = livePids(child.pid ? [child.pid, ...descendantsOf(child.pid)] : []);
  const receiptPath = args.receipt;
  let receipt: Receipt;
  try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt; }
  catch { receipt = { schema: 'pi-hermes-memory.rebuild-proof.receipt.v1', outcome: 'BLOCKED', reason: stderr || `worker exited with code ${exit.code}`, source: { repository: process.cwd() }, runner: { path: SCRIPT_PATH }, dependencies: { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch }, paths: { agentRoot: args.agentRoot, sessionsDir: args.sessionsDir, globalDir: args.globalDir, projectsMemoryDir: args.projectsMemoryDir, database: path.join(args.globalDir, 'sessions.db') }, counts: {}, warnings: [], errors: [stderr || `worker exited with code ${exit.code}`], supervision: { maxWallMs: args.maxWallMs, termGraceMs: args.termGraceMs, timedOut: false, descendants: 0, openFds: 0 }, metadataOnly: true }; }
  receipt.supervision = { maxWallMs: args.maxWallMs, termGraceMs: args.termGraceMs, timedOut, descendants: pids.length, openFds: openFdCount(pids) };
  if (timedOut || pids.length > 1 || receipt.supervision.openFds > 0 || exit.code !== 0) { receipt.outcome = 'BLOCKED'; receipt.reason = timedOut ? 'worker wall-clock timeout' : 'worker process/FD cleanup check failed'; }
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return receipt;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const receipt = args.worker ? await worker(args) : await supervise(args);
  writeFileSync(args.receipt, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  if (receipt.outcome !== 'PASS') process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH)) {
  void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
}
