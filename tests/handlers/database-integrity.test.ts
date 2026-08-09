import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerDatabaseIntegrityCommand } from '../../src/handlers/database-integrity.js';

type Command = { name: string; handler: (args: unknown, ctx: unknown) => Promise<void> };

function setup(manager: unknown) {
  const commands: Command[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const pi = {
    registerCommand(name: string, options: { handler: Command['handler'] }) {
      commands.push({ name, handler: options.handler });
    },
  };
  registerDatabaseIntegrityCommand(pi as never, manager as never);
  return { commands, notifications, ctx: { ui: { notify(message: string, level: string) { notifications.push({ message, level }); } } } };
}

describe('database integrity command', () => {
  it('registers exactly one unambiguous command', () => {
    const { commands } = setup({ checkIntegrity() {} });
    assert.deepStrictEqual(commands.map(({ name }) => name), ['memory-check-integrity']);
  });

  it('reports healthy when the explicit full check succeeds', async () => {
    let checks = 0;
    const { commands, notifications, ctx } = setup({ checkIntegrity() { checks++; } });
    await commands[0].handler({}, ctx);
    assert.equal(checks, 1);
    assert.match(notifications[0].message, /healthy/i);
    assert.match(notifications[0].message, /integrity_check/i);
  });

  it('recovers recognized corruption but never recovers ordinary errors', async () => {
    let recoveries = 0;
    const corruption = Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' });
    let recovered = false;
    const manager = {
      checkIntegrity() { if (!recovered) throw corruption; },
      recoverFromCorruption() {
        recoveries++;
        recovered = true;
        return { strategy: 'rebuilt', status: 'healthy', backupPaths: [] };
      },
    };
    const { commands, notifications, ctx } = setup(manager);
    await commands[0].handler({}, ctx);
    assert.equal(recoveries, 1);
    assert.match(notifications[0].message, /recovered/i);

    const ordinary = {
      checkIntegrity() { throw Object.assign(new Error('constraint failed'), { code: 'SQLITE_CONSTRAINT' }); },
      recoverFromCorruption() { recoveries++; return { strategy: 'rebuilt', status: 'healthy', backupPaths: [] }; },
    };
    const second = setup(ordinary);
    await second.commands[0].handler({}, second.ctx);
    assert.equal(recoveries, 1);
    assert.match(second.notifications[0].message, /failed/i);
  });

  it('reports failed when the post-recovery verification fails', async () => {
    let checks = 0;
    const manager = {
      checkIntegrity() {
        checks++;
        throw Object.assign(new Error('verification failed'), { code: 'SQLITE_CORRUPT' });
      },
      recoverFromCorruption() { return { strategy: 'rebuilt', status: 'healthy', backupPaths: [] }; },
    };
    const { commands, notifications, ctx } = setup(manager);
    await commands[0].handler({}, ctx);
    assert.equal(checks, 2);
    assert.match(notifications[0].message, /failed/i);
    assert.match(notifications[0].message, /verification/i);
  });

  it('does not recover constraint, migration, busy, or arbitrary errors', async () => {
    for (const error of [
      Object.assign(new Error('constraint failed'), { code: 'SQLITE_CONSTRAINT' }),
      Object.assign(new Error('migration failed'), { code: 'MIGRATION_FAILED' }),
      Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }),
      new Error('I/O failed'),
    ]) {
      let recoveries = 0;
      const manager = {
        checkIntegrity() { throw error; },
        recoverFromCorruption() { recoveries++; return { strategy: 'rebuilt', status: 'healthy', backupPaths: [] }; },
      };
      const { commands, notifications, ctx } = setup(manager);
      await commands[0].handler({}, ctx);
      assert.equal(recoveries, 0, error.message);
      assert.match(notifications[0].message, /failed/i);
    }
  });

  it('reports recreated-empty as degraded after successful runtime recheck', async () => {
    let checks = 0;
    const manager = {
      checkIntegrity() {
        checks++;
        if (checks === 1) throw Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' });
      },
      recoverFromCorruption() { return { strategy: 'recreated-empty', status: 'degraded', backupPaths: [] }; },
    };
    const { commands, notifications, ctx } = setup(manager);
    await commands[0].handler({}, ctx);
    assert.equal(checks, 2);
    assert.match(notifications[0].message, /degraded/i);
    assert.doesNotMatch(notifications[0].message, /healthy/i);
  });
});
