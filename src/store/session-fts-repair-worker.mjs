import fs from 'node:fs';
import { createRequire } from 'node:module';

let db;
let identity;
const send = (value) => process.send?.(value);
process.on('disconnect', () => { try { db?.close(); } finally { process.exit(0); } });

process.on('message', async (request) => {
  try {
    const current = fs.statSync(request.dbPath);
    if (current.dev !== request.identity.dev || current.ino !== request.identity.ino) throw new Error('FTS repair database generation changed');
    if (!db || identity.dev !== current.dev || identity.ino !== current.ino) {
      db?.close();
      const Database = process.versions.bun
        ? (await import('bun:sqlite')).Database
        : createRequire(import.meta.url)(request.sqliteModule);
      db = new Database(request.dbPath);
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=1000; PRAGMA foreign_keys=ON;');
      identity = { dev: current.dev, ino: current.ino };
    }
    db.exec('BEGIN IMMEDIATE');
    let state;
    try {
      const row = db.prepare('SELECT value FROM extension_metadata WHERE key = ?').get(request.repairKey);
      state = JSON.parse(row.value);
      if (state.phase !== request.phase || state.cursor !== request.cursor || !!state.ftsInitialized !== request.initialized) throw new Error('FTS repair state changed before the worker acquired its write lock');
      if (state.phase !== 'message_fts' && state.phase !== 'memory_fts') throw new Error('Invalid FTS repair phase');
      const messages = state.phase === 'message_fts';
      const table = messages ? 'message_fts' : 'memory_fts';
      const source = messages ? 'messages' : 'memories';
      const key = messages ? 'rowid' : 'id';
      state = { ...state, status: 'running', updatedAt: new Date().toISOString() };
      if (!state.ftsInitialized) {
        if (request.recreate) db.exec(`DROP TABLE IF EXISTS ${table}; ${request.schemaSql};`);
        db.exec(request.triggersSql);
        state = { ...state, ftsInitialized: true, cursor: 0 };
      } else {
        // Only integer keys cross JavaScript; SQLite retains the full payloads.
        const rows = db.prepare(`SELECT ${key} AS id FROM ${source} WHERE ${key} > ? ORDER BY ${key} LIMIT ?`).all(state.cursor, request.chunkSize);
        if (rows.length) {
          const last = Number(rows[rows.length - 1].id);
          db.prepare(`INSERT OR REPLACE INTO ${table}(rowid, content) SELECT ${key}, content FROM ${source} WHERE ${key} > ? AND ${key} <= ?`).run(state.cursor, last);
          state = { ...state, cursor: last };
        } else {
          state = { ...state, phase: messages ? 'memory_fts' : 'verify', cursor: 0, ftsInitialized: false };
        }
      }
      db.prepare('INSERT INTO extension_metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(request.repairKey, JSON.stringify(state));
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    send({ ok: true, state });
  } catch (error) {
    send({ ok: false, error: { message: String(error?.message ?? error), code: error?.code } });
  }
});
