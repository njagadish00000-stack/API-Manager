/**
 * Plugin manager (§38): install/uninstall/enable local plugin folders
 * (manifest.json + entry JS), run lifecycle hooks in a vm sandbox with a
 * permission-checked context API, and validate manifests.
 */
import AdmZip from 'adm-zip';
import vm from 'node:vm';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import AdmZipType from 'adm-zip';
import type { Plugin, PluginManifest } from '../../shared/types';
import { uid } from '../../shared/ids';
import { now } from '../../shared/types';

export interface PluginDeps {
  pluginsDir: string;
  listPlugins: () => Plugin[];
  savePlugin: (p: Plugin) => Plugin;
  deletePlugin: (id: string) => void;
  emitConsole: (level: string, source: string, message: string) => void;
}

const ALLOWED_PERMISSIONS = new Set(['pre-request', 'post-response', 'console', 'variables', 'console.write', 'http-log']);

export function validateManifest(raw: unknown): { ok: boolean; manifest?: PluginManifest; errors: string[] } {
  const errors: string[] = [];
  const m = raw as Partial<PluginManifest> | undefined;
  if (!m || typeof m !== 'object') return { ok: false, errors: ['manifest is not an object'] };
  if (!m.id || typeof m.id !== 'string') errors.push('id missing');
  if (!m.name) errors.push('name missing');
  if (!m.version) errors.push('version missing');
  if (!m.entry || typeof m.entry !== 'string') errors.push('entry missing');
  if (m.entry && /[/\\]/.test(m.entry)) errors.push('entry must be a simple file name');
  for (const p of m.permissions ?? []) if (!ALLOWED_PERMISSIONS.has(p)) errors.push(`unknown permission: ${p}`);
  return { ok: errors.length === 0, manifest: m as PluginManifest, errors };
}

export function installPlugin(path: string, deps: PluginDeps): Plugin {
  const dir = join(deps.pluginsDir, uid());
  mkdirSync(dir, { recursive: true });
  if (path.endsWith('.zip')) {
    const zip = new AdmZipType(path);
    zip.extractAllTo(dir, true);
  } else if (existsSync(join(path, 'manifest.json'))) {
    cpSync(path, dir, { recursive: true });
  } else {
    throw new Error(`Plugin source not recognized: ${path} (expected folder with manifest.json or .zip)`);
  }
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('Plugin missing manifest.json at root');
  }
  const { ok, manifest, errors } = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  if (!ok || !manifest) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Invalid plugin manifest: ${errors.join('; ')}`);
  }
  if (!existsSync(join(dir, manifest.entry))) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Plugin entry file not found: ${manifest.entry}`);
  }
  const plugin: Plugin = { id: uid(), manifest, enabled: true, installedAt: now(), path: dir };
  return deps.savePlugin(plugin);
}

export function uninstallPlugin(id: string, deps: PluginDeps): void {
  const plugin = deps.listPlugins().find((p) => p.id === id);
  if (!plugin) throw new Error(`Plugin not found: ${id}`);
  deps.deletePlugin(id);
  try { rmSync(plugin.path, { recursive: true, force: true }); } catch { /* keep registry consistent */ }
}

export interface PluginHookResult { payload?: unknown; logs: string[] }

export function runPluginHook(plugin: Plugin, hook: string, payloadJson: string, deps: PluginDeps): PluginHookResult {
  if (!plugin.enabled) throw new Error('Plugin is disabled');
  const contextPath = join(plugin.path, plugin.manifest.entry);
  const code = readFileSync(contextPath, 'utf8');
  let payload: unknown;
  try { payload = JSON.parse(payloadJson); } catch { throw new Error('payloadJson is not valid JSON'); }
  const logs: string[] = [];
  const api = {
    hasPermission: (p: string) => (plugin.manifest.permissions ?? []).includes(p),
    log: (...args: unknown[]) => {
      const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      logs.push(line);
      deps.emitConsole('log', `plugin:${plugin.manifest.name}`, line);
    },
  };
  const sandbox: Record<string, unknown> = {
    pluginApi: api,
    payload,
    console: { log: api.log, warn: api.log, error: api.log },
    setTimeout: undefined, setInterval: undefined, process: undefined, require: undefined,
    exports: {}, module: { exports: {} },
  };
  try {
    const context = vm.createContext(sandbox, { name: `plugin:${plugin.manifest.id}` });
    const script = new vm.Script(`'use strict';\n${code}`, { filename: contextPath });
    script.runInContext(context, { timeout: 5000, displayErrors: true });
    const module = sandbox.module as { exports: Record<string, unknown> };
    const hookFn = module.exports[hook] ?? (sandbox.exports as Record<string, unknown>)[hook];
    if (typeof hookFn === 'function') {
      const result = hookFn(payload, api) as unknown;
      return { payload: result ?? payload, logs };
    }
    return { payload, logs };
  } catch (e) {
    throw new Error(`Plugin hook failed: ${e instanceof Error ? e.message : e}`);
  }
}

export function pluginListInfo(deps: PluginDeps): Plugin[] { return deps.listPlugins(); }

export function setPluginEnabled(id: string, enabled: boolean, deps: PluginDeps): void {
  const existing = deps.listPlugins().find((p) => p.id === id);
  if (!existing) throw new Error(`Plugin not found: ${id}`);
  deps.savePlugin({ ...existing, enabled });
}

export function persistManifest(dir: string, manifest: PluginManifest): void {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

export function zipPlugin(dir: string, outPath: string): { path: string } {
  const zip = new AdmZip();
  zip.addLocalFolder(dir);
  zip.writeZip(outPath);
  return { path: outPath };
}
