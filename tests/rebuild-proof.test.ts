import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const runner = path.join(repo, 'scripts', 'rebuild-proof.ts');

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-hermes-rebuild-proof-'));
  const agent = path.join(root, 'scope', 'agent');
  mkdirSync(path.join(agent, 'pi-hermes-memory'), { recursive: true });
  mkdirSync(path.join(agent, 'projects-memory'), { recursive: true });
  mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  const receipt = path.join(root, 'receipt.json');
  return { root, agent, receipt };
}

function invoke(fixtureRoot: ReturnType<typeof fixture>, extra: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const { agent, receipt } = fixtureRoot;
  return spawnSync('npx', ['tsx', runner, '--agent-root', agent, '--sessions-dir', path.join(agent, 'sessions'), '--global-dir', path.join(agent, 'pi-hermes-memory'), '--projects-memory-dir', path.join(agent, 'projects-memory'), '--receipt', receipt, ...extra], {
    cwd: repo,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('fails closed for missing worker bindings before DB creation', () => {
  const f = fixture();
  try {
    const result = invoke(f, ['--worker'], { PI_CODING_AGENT_DIR: '', PI_CODING_AGENT_SESSION_DIR: '' });
    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, '');
    const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'));
    assert.equal(receipt.outcome, 'BLOCKED');
    assert.match(receipt.reason, /explicit/);
    assert.equal(requireDb(f), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('fails closed for wrong environment binding before DB creation', () => {
  const f = fixture();
  try {
    const result = invoke(f, ['--worker'], { PI_CODING_AGENT_DIR: path.join(f.root, 'wrong'), PI_CODING_AGENT_SESSION_DIR: path.join(f.agent, 'sessions') });
    assert.notEqual(result.status, 0);
    const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'));
    assert.equal(receipt.outcome, 'BLOCKED');
    assert.match(receipt.reason, /bindings/);
    assert.equal(requireDb(f), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('blocks an expected manifest mismatch before opening SQLite', () => {
  const f = fixture();
  const manifest = path.join(f.root, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ files: [{ path: path.join(f.agent, 'sessions', 'missing.jsonl'), size: 1 }] }));
  try {
    const result = invoke(f, ['--worker', '--expected-manifest', manifest], { PI_CODING_AGENT_DIR: f.agent, PI_CODING_AGENT_SESSION_DIR: path.join(f.agent, 'sessions') });
    assert.notEqual(result.status, 0);
    const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'));
    assert.equal(receipt.outcome, 'BLOCKED');
    assert.match(receipt.reason, /manifest file missing/);
    assert.equal(requireDb(f), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('uses the direct dynamic-import path and writes a metadata-only receipt', () => {
  const f = fixture();
  try {
    const result = invoke(f);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'));
    assert.equal(receipt.outcome, 'PASS');
    assert.equal(receipt.metadataOnly, true);
    assert.equal(receipt.paths.database, path.join(f.agent, 'pi-hermes-memory', 'sessions.db'));
    assert.equal(typeof receipt.dependencies.node, 'string');
    assert.equal(typeof receipt.dependencies.abi, 'string');
    assert.equal(receipt.counts.sessions, 0);
    assert.equal(receipt.counts.messages, 0);
    assert.equal(receipt.counts.memories, 0);
    assert.equal(Object.prototype.hasOwnProperty.call(receipt, 'payload'), false);
    const source = readFileSync(runner, 'utf8');
    assert.ok(source.indexOf('const paths = validateBindings(args)') < source.indexOf("await import('../src/store/db.js')"));
    assert.equal(source.includes("from '../src/index.js'"), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('supervisor terminates a timed-out detached worker group', () => {
  const f = fixture();
  try {
    const result = invoke(f, ['--max-wall-ms', '100', '--term-grace-ms', '50'], { REBUILD_TEST_SLEEP_MS: '1000' });
    assert.notEqual(result.status, 0);
    const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'));
    assert.equal(receipt.outcome, 'BLOCKED');
    assert.equal(receipt.supervision.timedOut, true);
    assert.equal(receipt.supervision.descendants, 0);
    assert.equal(receipt.supervision.openFds, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

function requireDb(f: ReturnType<typeof fixture>): boolean {
  return existsSync(path.join(f.agent, 'pi-hermes-memory', 'sessions.db'));
}
