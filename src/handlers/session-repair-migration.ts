import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { DatabaseManager, SessionRepairState } from '../store/db.js';

export const SESSION_REPAIR_CHUNK_SIZE = 16;
export const SESSION_REPAIR_WALL_CLOCK_BUDGET_MS = 35;
export const SESSION_REPAIR_INITIAL_DELAY_MS = 500;
export const SESSION_REPAIR_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface SessionRepairMigrationState {
  inProgress: boolean;
  promise: Promise<void> | null;
  abortController?: AbortController;
  cancel?: () => void;
  last?: SessionRepairState | null;
}

export const sessionRepairMigrationState: SessionRepairMigrationState = {
  inProgress: false,
  promise: null,
};

const macrotaskYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Start resumable repair work without putting any row scan on first open. */
export function scheduleSessionRepairMigration(
  dbManager: DatabaseManager,
  state: SessionRepairMigrationState = sessionRepairMigrationState,
): boolean {
  if (state.inProgress) return false;
  const current = dbManager.getSessionRepairState();
  if (!current || current.status === 'complete') return false;

  const controller = new AbortController();
  state.inProgress = true;
  state.abortController = controller;
  let resolveTask!: () => void;
  state.promise = new Promise<void>((resolve) => { resolveTask = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let cancelled = false;
  state.cancel = () => {
    cancelled = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    controller.abort();
    // If the initial delay has not elapsed, no async runner exists to reach
    // finally. Complete the task here so the singleton can be scheduled again
    // and cancellation cannot trigger any database activity later.
    if (!started) {
      state.inProgress = false;
      state.promise = null;
      state.abortController = undefined;
      state.cancel = undefined;
      resolveTask();
    }
  };

  const run = async (): Promise<void> => {
    try {
      while (!controller.signal.aborted && !cancelled) {
        const next = await dbManager.runSessionRepairChunk({
          chunkSize: SESSION_REPAIR_CHUNK_SIZE,
          signal: controller.signal,
          yieldFn: macrotaskYield,
        });
        state.last = next;
        if (!next || next.status === 'complete' || next.status === 'aborted') break;
      }
    } catch (error) {
      // Background work must never become an unhandled rejection. The durable
      // state remains pending/running and the next startup can resume it.
      if (!cancelled) state.last = state.last ?? null;
    } finally {
      state.inProgress = false;
      state.promise = null;
      state.abortController = undefined;
      state.cancel = undefined;
      resolveTask();
    }
  };
  timer = setTimeout(() => {
    timer = undefined;
    if (!cancelled) {
      started = true;
      void run().catch(() => undefined);
    } else {
      resolveTask();
    }
  }, SESSION_REPAIR_INITIAL_DELAY_MS);
  return true;
}

export interface RunSessionRepairToCompletionOptions {
  chunkSize?: number;
  wallClockBudgetMs?: number;
  maxChunks?: number;
  signal?: AbortSignal;
  yieldFn?: () => Promise<void>;
}

/** Explicit operator/test hook that resumes durable chunks until publication. */
export async function runSessionRepairToCompletion(
  dbManager: DatabaseManager,
  options: RunSessionRepairToCompletionOptions = {},
): Promise<SessionRepairState> {
  const maxChunks = Math.max(1, Math.floor(options.maxChunks ?? 100_000));
  for (let chunk = 0; chunk < maxChunks; chunk += 1) {
    const state = await dbManager.runSessionRepairChunk({
      chunkSize: options.chunkSize ?? SESSION_REPAIR_CHUNK_SIZE,
      wallClockBudgetMs: options.wallClockBudgetMs ?? SESSION_REPAIR_WALL_CLOCK_BUDGET_MS,
      signal: options.signal,
      yieldFn: options.yieldFn ?? macrotaskYield,
    });
    if (!state) throw new Error('Session repair state is unavailable');
    if (state.status === 'complete' || state.status === 'aborted') return state;
  }
  throw new Error(`Session repair exceeded ${maxChunks} chunks`);
}

/** Register explicit operator status/continue control for long pending repairs. */
export function registerSessionRepairCommand(pi: ExtensionAPI, dbManager: DatabaseManager): void {
  pi.registerCommand('memory-session-repair', {
    description: 'Show or continue the durable session evidence repair',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const action = args.trim().toLowerCase() || 'status';
      if (action === 'status') {
        const state = dbManager.getSessionRepairState();
        ctx.ui.notify(state ? `Session repair: ${state.status}${state.phase ? `/${state.phase}` : ''}, ${state.processed}/${state.total}` : 'Session repair: unavailable', 'info');
        return;
      }
      if (action !== 'continue') {
        ctx.ui.notify('Usage: /memory-session-repair [status|continue]', 'warning');
        return;
      }
      try {
        const state = await runSessionRepairToCompletion(dbManager, { maxChunks: 10_000 });
        ctx.ui.notify(`Session repair: ${state.status}${state.phase ? `/${state.phase}` : ''}, ${state.processed}/${state.total}`, state.status === 'complete' ? 'info' : 'warning');
      } catch (error) {
        ctx.ui.notify(`Session repair continuation failed: ${error instanceof Error ? error.message : String(error)}`, 'warning');
      }
    },
  });
}

/** A cancellable timeout waits for the repair task to release its writer fence. */
export async function waitForSessionRepairMigration(
  timeoutMs = SESSION_REPAIR_SHUTDOWN_TIMEOUT_MS,
  state: SessionRepairMigrationState = sessionRepairMigrationState,
): Promise<boolean> {
  const promise = state.promise;
  if (!state.inProgress || !promise) return true;
  const canCancel = typeof state.cancel === 'function';
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => { state.cancel?.(); resolve(false); }, timeoutMs);
      }),
    ]);
    // Cancellation requests process termination; task settlement confirms reaping
    // and releases the manager's mutation lease before shutdown closes SQLite.
    if (!completed && canCancel) await promise;
    return completed;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
