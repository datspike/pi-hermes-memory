import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { DatabaseManager, type DatabaseRecoveryResult } from '../store/db.js';

/** Register the explicit operator check; normal startup never performs this scan. */
export function registerDatabaseIntegrityCommand(pi: ExtensionAPI, manager: DatabaseManager): void {
  pi.registerCommand('memory-check-integrity', {
    description: 'Run a full SQLite integrity check and recover recognized corruption',
    handler: async (_args, ctx) => {
      try {
        manager.checkIntegrity();
        ctx.ui.notify('Database integrity: healthy (integrity_check ok).', 'info');
        return;
      } catch (error) {
        if (!DatabaseManager.isCorruptionError(error)) {
          ctx.ui.notify(`Database integrity: failed (no recovery attempted): ${errorMessage(error)}`, 'error');
          return;
        }

        let recovery: DatabaseRecoveryResult;
        try {
          recovery = manager.recoverFromCorruption(error);
          // The recovery coordinator verifies the final generation too. Repeat the
          // public check here so the operator command reports the published state.
          manager.checkIntegrity();
        } catch (verificationError) {
          ctx.ui.notify(`Database integrity: failed (recovery verification failed): ${errorMessage(verificationError)}`, 'error');
          return;
        }

        if (recovery.status === 'degraded' || recovery.strategy === 'recreated-empty') {
          ctx.ui.notify(
            `Database integrity: degraded (recreated-empty; canonical rehydration is required).`,
            'warning',
          );
        } else {
          ctx.ui.notify(`Database integrity: recovered (rebuilt; integrity_check ok).`, 'info');
        }
      }
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
