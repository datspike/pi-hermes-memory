// The supported Node SDK requires Node >=22.19; Bun loads TypeScript natively.
// Keep the source loader local to this process and this package, not the Pi host.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.once('message', async request => {
  let reply;
  try {
    if (!('Bun' in globalThis)) {
      const { registerHooks, stripTypeScriptTypes } = await import('node:module');
      const root = new URL('../', import.meta.url).href;
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(root)) {
            const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
            if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
          }
          return nextResolve(specifier, context);
        },
        load(url, context, nextLoad) {
          if (url.startsWith(root) && url.endsWith('.ts')) {
            return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform', sourceUrl: url }) };
          }
          return nextLoad(url, context);
        },
      });
    }
    const { executeSearchWorker } = await import('./session-search-worker.ts');
    process.send({ type: 'progress' });
    reply = { type: 'result', ok: true, result: executeSearchWorker(request) };
  } catch (error) {
    reply = { type: 'result', ok: false, error: { name: error?.name ?? 'Error', message: error?.message ?? String(error), code: error?.code } };
  }
  process.send(reply, () => process.disconnect());
});
