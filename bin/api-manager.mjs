#!/usr/bin/env node
/**
 * api-manager CLI launcher — prefers built dist; falls back to tsx-style
 * strip-types execution of TypeScript directly (Node 22.6+).
 * `node --experimental-strip-types` handles the repo's TS (erasable-only).
 */
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  join(root, 'dist', 'cli', 'main.cjs'),
  join(root, 'dist', 'cli', 'main.js'),
  join(root, 'src', 'cli', 'main.ts'),
];
const main = candidates.find((p) => existsSync(p));
if (!main) {
  console.error('CLI not built — run npm run build');
  process.exit(2);
}
const isTs = main.endsWith('.ts');
const args = isTs ? ['--experimental-strip-types', '--no-warnings', main, ...process.argv.slice(2)] : [main, ...process.argv.slice(2)];
const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: process.cwd() });
process.exit(r.status ?? 0);
