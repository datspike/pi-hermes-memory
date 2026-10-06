import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { SessionSearchOptions, SessionSearchEvidenceOptions } from './session-search.js';
import type { SessionSearchToolResult } from './session-search-output.js';
import { isBunRuntime } from './sqlite-native.js';

export const SESSION_SEARCH_TIMEOUT_MS = 60_000;

export type SessionSearchWorkerRequest =
  | { mode: 'legacy'; dbPath: string; query: string; snippetChars?: number; options: SessionSearchOptions }
  | { mode: 'structured'; dbPath: string; query: string; options: SessionSearchEvidenceOptions }
  | { mode: 'anchors'; markdown: string; sessionsDir: string };

export interface SessionSearchExecutionOptions {
  signal?: AbortSignal;
  /** Internal execution deadline; not a model-controlled search parameter. */
  timeoutMs?: number;
  onProgress?: (phase?: 'waiting_for_coverage') => void;
}

interface WorkerError { name: string; message: string; code?: string }
interface WorkerReply { type: 'result'; ok: boolean; result?: SessionSearchToolResult; error?: WorkerError }
type WorkerMessage = WorkerReply | { type: 'progress'; phase?: 'waiting_for_coverage' };

/** Run one tool request in a separate process and reap it before settling. */
export async function runSessionSearch(request: SessionSearchWorkerRequest, options: SessionSearchExecutionOptions = {}): Promise<SessionSearchToolResult> {
  const { signal } = options;
  const cancelled = () => Object.assign(new Error('Session search cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
  if (signal?.aborted) throw cancelled();
  const timeoutMs = options.timeoutMs ?? SESSION_SEARCH_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Session search timeout must be positive and finite.');
  return new Promise((resolve, reject) => {
    const bun = isBunRuntime();
    const child = fork(fileURLToPath(new URL('./session-search-worker.mjs', import.meta.url)), [], {
      execPath: process.execPath,
      execArgv: bun ? [] : ['--max-old-space-size=256', '--disable-warning=ExperimentalWarning'],
      // BUN_BE_BUN also makes a compiled Pi executable run this script as Bun.
      env: { ...process.env, NODE_OPTIONS: '', ...(bun ? { BUN_BE_BUN: '1' } : {}) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let reply: WorkerReply | undefined;
    let failure: Error | undefined;
    let settled = false;
    let waitingForCoverage = false;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 4_096) stderr += chunk.toString('utf8').slice(0, 4_096 - stderr.length); });
    const stop = (error: Error) => {
      if (settled || failure) return;
      failure = error;
      // SIGKILL interrupts SQLite's native call; Worker.terminate() cannot do that.
      child.kill('SIGKILL');
    };
    const abort = () => stop(cancelled());
    const timer = setTimeout(() => stop(Object.assign(new Error(waitingForCoverage ? 'Session search timed out while waiting for index coverage verification; retry after verification completes.' : 'Session search timed out; narrow the project, session, or query.'), { name: 'SessionSearchTimeoutError', code: 'SESSION_SEARCH_TIMEOUT' })), timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('message', (value: WorkerMessage) => {
      if (value.type === 'progress') {
        waitingForCoverage = value.phase === 'waiting_for_coverage';
        try { options.onProgress?.(value.phase); } catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
      } else { reply = value; }
    });
    child.once('error', (error: Error) => { failure ??= error; });
    child.once('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) { reject(failure); return; }
      if (code !== 0 || !reply) { reject(new Error(`Session search process exited without a result (code ${code}).${stderr ? ` ${stderr.trim()}` : ''}`)); return; }
      if (!reply.ok) { reject(Object.assign(new Error(reply.error?.message ?? 'Session search failed.'), { name: reply.error?.name ?? 'Error', ...(reply.error?.code ? { code: reply.error.code } : {}) })); return; }
      if (!reply.result) { reject(new Error('Session search process returned no result.')); return; }
      resolve(reply.result);
    });
    if (!failure) child.send(request, (error: Error | null) => { if (error) stop(error); });
  });
}
