/**
 * Standalone hub entrypoint: `npm run hub` / `node dist/hub/hub.mjs`.
 * Owns the AppContainer + registry and serves renderer + WS/HTTP bridge.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { createContainer } from './container';
import { createRegistry } from './registry';
import { startHub } from '../hub/server';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dataDir = getArg('data-dir')
    ?? process.env.API_MANAGER_DATA_DIR
    ?? join(homedir(), '.api-manager');
  const port = Number(getArg('port') ?? process.env.API_MANAGER_PORT ?? 7654);
  const token = getArg('token') ?? process.env.API_MANAGER_TOKEN;

  const container = await createContainer({ dataDir });
  const registry = createRegistry(container);

  const metaDir = typeof import.meta !== 'undefined' ? (import.meta as unknown as { dirname?: string }).dirname : undefined;
  const rendererDirCandidates = [
    join(process.cwd(), 'dist', 'renderer'),
    ...(metaDir ? [join(metaDir, '..', 'renderer'), join(metaDir, 'renderer')] : []),
  ];
  const staticDir = rendererDirCandidates.find((p) => existsSync(join(p, 'index.html')));


  const handle = await startHub({
    container, registry, port,
    staticDir,
    authToken: token,
    log: (m: string) => console.error(m),
  });

  console.log(JSON.stringify({
    app: 'API Manager', url: handle.url, port: handle.port,
    token: token ? '(env-supplied)' : handle.token,
    dataDir, methods: registry.methods.length,
    webUI: staticDir ? `${handle.url}/` : '(renderer bundle not built — run npm run build:renderer)',
  }, null, 2));

  const shutdown = (): void => {
    void handle.close().then(() => container.flush()).then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error('Hub failed to start:', e); process.exit(1); });
