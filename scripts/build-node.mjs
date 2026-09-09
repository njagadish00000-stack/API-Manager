#!/usr/bin/env node
/**
 * Build all Node targets (hub, electron main+preload, CLI) with esbuild.
 * Output layout:
 *   dist/hub/hub.mjs          — hub server entry (ESM, external deps)
 *   dist/cli/main.cjs         — CLI entry (CJS bundle, all deps inlined except heavy natives)
 *   dist/electron/main.cjs    — electron main process
 *   dist/electron/preload.cjs — electron preload
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
mkdirSync(join(root, 'dist', 'hub'), { recursive: true });
mkdirSync(join(root, 'dist', 'cli'), { recursive: true });
mkdirSync(join(root, 'dist', 'electron'), { recursive: true });

// packages that load native/shared objects or are otherwise dynamic — keep external
const external = [
  'electron', '@grpc/grpc-js', '@grpc/proto-loader', 'sql.js', 'ws',
  'better-sqlite3', 'sqlite3', 'serialport', 'node-dir',
];
const ignorePackagesPlugin = {
  name: 'externalize-optional',
  setup(b) {
    // protobufjs etc are fine to bundle; only mark listed externals
  },
};

async function run() {
  const define = { 'process.env.NODE_ENV': '"production"' };

  await build({
    entryPoints: [join(root, 'src/runtime/start-hub.ts')],
    outfile: join(root, 'dist/hub/hub.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node20',
    external,
    define,
    sourcemap: true,
    
  });

  await build({
    entryPoints: [join(root, 'src/cli/main.ts')],
    outfile: join(root, 'dist/cli/main.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node20',
    external,
    define,
    sourcemap: true,
  });

  await build({
    entryPoints: [join(root, 'src/main/main.ts')],
    outfile: join(root, 'dist/electron/main.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node20',
    external,
    define,
    sourcemap: true,
  });

  await build({
    entryPoints: [join(root, 'src/main/preload.ts')],
    outfile: join(root, 'dist/electron/preload.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node20',
    external: ['electron'],
    define,
  });

  console.log('built dist/hub/hub.cjs, dist/cli/main.cjs, dist/electron/{main,preload}.cjs');
}

run().catch((e) => { console.error(e); process.exit(1); });
