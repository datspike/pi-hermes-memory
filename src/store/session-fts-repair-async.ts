import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { SessionRepairState } from './db.js';
import { isBunRuntime } from './sqlite-native.js';

export interface FtsRepairRequest {
  dbPath: string;
  identity: { dev: number; ino: number };
  sqliteModule?: string;
  repairKey: string;
  phase: 'message_fts' | 'memory_fts';
  cursor: number;
  initialized: boolean;
  recreate: boolean;
  schemaSql: string;
  triggersSql: string;
  chunkSize: number;
}

interface Reply { ok: boolean; state?: SessionRepairState; error?: { message: string; code?: string } }
interface Pending { resolve: (state: SessionRepairState) => void; reject: (error: Error) => void; failure?: Error; cleanup: () => void }

/** Keep one SQL-only worker warm; cancellation settles only after the process closes. */
export class FtsRepairProcess {
  private child: ChildProcess | null = null;
  private pending: Pending | null = null;

  get busy(): boolean { return this.pending !== null; }

  stop(): void { this.child?.kill('SIGKILL'); }

  private open(): ChildProcess {
    if (this.child) return this.child;
    const bun = isBunRuntime();
    const child = fork(fileURLToPath(new URL('./session-fts-repair-worker.mjs', import.meta.url)), [], {
      execPath: process.execPath,
      execArgv: bun ? [] : ['--max-old-space-size=256', '--disable-warning=ExperimentalWarning'],
      env: { ...process.env, NODE_OPTIONS: '', ...(bun ? { BUN_BE_BUN: '1' } : {}) },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.child = child;
    child.on('message', (reply: Reply) => {
      const pending = this.pending;
      if (!pending || pending.failure) return;
      pending.cleanup();
      this.pending = null;
      child.unref();
      child.channel?.unref?.();
      if (reply.ok && reply.state) pending.resolve(reply.state);
      else pending.reject(Object.assign(new Error(reply.error?.message ?? 'FTS repair returned no state'), { code: reply.error?.code }));
    });
    child.once('error', (error) => { if (this.pending) this.pending.failure ??= error; });
    child.once('close', (code) => {
      if (this.child === child) this.child = null;
      const pending = this.pending;
      this.pending = null;
      pending?.cleanup();
      pending?.reject(pending.failure ?? new Error(`FTS repair process exited without a result (code ${code})`));
    });
    return child;
  }

  run(request: FtsRepairRequest, signal?: AbortSignal): Promise<SessionRepairState> {
    if (this.pending) return Promise.reject(new Error('An FTS repair request is already running'));
    const cancelled = () => Object.assign(new Error('FTS repair cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
    if (signal?.aborted) return Promise.reject(cancelled());
    const child = this.open();
    child.ref();
    child.channel?.ref?.();
    return new Promise((resolve, reject) => {
      const stop = (error: Error) => { if (!this.pending || this.pending.failure) return; this.pending.failure = error; this.stop(); };
      const abort = () => stop(cancelled());
      // Dropping a populated shadow tree can outlast an ordinary row chunk; both remain cancellable.
      const timeoutMs = !request.initialized && request.recreate ? 300_000 : 60_000;
      const timer = setTimeout(() => stop(new Error('FTS repair step timed out')), timeoutMs);
      this.pending = { resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      if (!this.pending.failure) child.send(request, (error) => { if (error) stop(error); });
    });
  }
}
