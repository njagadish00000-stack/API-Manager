/**
 * API Manager CLI (§CLI — newman-class) — fully offline, works standalone
 * against the local data directory. Exit codes: 0 ok, 1 failures, 2 usage/other.
 */
import { Command } from 'commander';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { AppContainer } from '../runtime/container';

interface CliCtx { container: AppContainer; registry: ReturnType<typeof import('../runtime/registry')['createRegistry']>; verbose: boolean }

const program = new Command();
program
  .name('api-manager')
  .description('API Manager CLI — offline-first API development & automation (newman-class)')
  .version('1.0.0');

function dataDirOption(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opts = (program as any).optsWithGlobals() as { dataDir?: string };
  return opts.dataDir ?? process.env.API_MANAGER_DATA_DIR ?? join(homedir(), '.api-manager');
}

async function withCtx<T>(fn: (ctx: CliCtx) => Promise<T>, opts?: { vaultPassword?: string }): Promise<T> {
  const { createContainer } = await import('../runtime/container');
  const { createRegistry } = await import('../runtime/registry');
  const container = await createContainer({ dataDir: dataDirOption(), log: () => undefined });
  const registry = createRegistry(container);
  try {
    if (opts?.vaultPassword) {
      await container.vault.unlock(opts.vaultPassword).catch(() => undefined);
    }
    return await fn({ container, registry, verbose: false });
  } finally {
    await container.flush();
  }
}

type AnyRegistry = CliCtx['registry'];
type AnyCall = (method: string, params: unknown) => Promise<unknown>;
const callAny = (r: AnyRegistry): AnyCall => r.call as unknown as AnyCall;

function out(value: unknown, jsonMode: boolean): void {
  if (jsonMode) { console.log(JSON.stringify(value, null, 2)); return; }
  if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

function fail(msg: string, code = 1): never { console.error(msg); process.exit(code); }
const asObj = (s: unknown): Record<string, unknown> => (typeof s === 'object' && s !== null ? s as Record<string, unknown> : {});

async function resolveEnvironmentId(registry: CliCtx['registry'], name?: string): Promise<string | undefined> {
  if (!name) return undefined;
  const envs = await callAny(registry)('environment.list', {}) as { id: string; name: string }[];
  const lower = name.toLowerCase();
  const match = envs.find((e) => e.id === name) ?? envs.find((e) => e.name.toLowerCase() === lower);
  if (!match) fail(`Environment not found: ${name}`);
  return match.id;
}

async function resolveCollectionId(registry: CliCtx['registry'], name: string): Promise<string> {
  const cols = await callAny(registry)('collection.list', {}) as { id: string; name: string }[];
  const lower = name.toLowerCase();
  const match = cols.find((c) => c.id === name) ?? cols.find((c) => c.name.toLowerCase() === lower);
  if (!match) fail(`Collection not found: ${name}. Use 'api-manager collection list' to see names.`);
  return match.id;
}

async function waitRun(registry: CliCtx['registry'], runId: string, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const showProgress = env.API_MANAGER_QUIET !== '1' && Boolean(process.stderr.isTTY);
  for (;;) {
    const status = asObj((await callAny(registry)('run.get', { runId })));
    const state = String(status.status ?? 'finished');
    if (showProgress && typeof status.executedRequests === 'number') {
      process.stderr.write(`\rexecuted ${status.executedRequests}/${String(status.totalRequests ?? '?')}   `);
    }
    if (['finished', 'completed', 'failed', 'stopped', 'paused'].includes(state)) { if (showProgress) process.stderr.write('\n'); return status; }
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ---------------- send ----------------
program.command('send')
  .description('Send a one-off HTTP request')
  .argument('<url>')
  .option('-X, --method <method>', 'HTTP method', 'GET')
  .option('-H, --header <header...>', 'Header "Key: Value"')
  .option('-d, --data <data>', 'Request body')
  .option('--json <json>', 'JSON body')
  .option('-e, --environment <name>', 'Environment (name or id)')
  .option('--timeout <ms>', 'Timeout ms', '30000')
  .option('-i, --include-headers', 'Include response headers', false)
  .option('--json-output', 'Full JSON response dump', false)
  .action(async (url: string, cmd: { method: string; header?: string[]; data?: string; json?: string; environment?: string; timeout: string; includeHeaders: boolean; jsonOutput: boolean }) => {
    await withCtx(async ({ registry }) => {
      const environmentId = await resolveEnvironmentId(registry, cmd.environment);
      const headers = (cmd.header ?? []).map((h) => {
        const i = h.indexOf(':');
        return { id: String(i), key: i >= 0 ? h.slice(0, i).trim() : h, value: i >= 0 ? h.slice(i + 1).trim() : '', enabled: true };
      });
      let body: Record<string, unknown> = { type: 'none' };
      if (cmd.json) { body = { type: 'json', raw: cmd.json }; if (!headers.some((h) => h.key.toLowerCase() === 'content-type')) headers.push({ id: 'ct', key: 'Content-Type', value: 'application/json', enabled: true }); }
      else if (cmd.data) body = { type: 'text', raw: cmd.data };
      const request = {
        id: 'cli-' + Date.now(), workspaceId: '', name: `${cmd.method} ${url}`, method: cmd.method.toUpperCase(), url,
        pathParams: [], queryParams: [], headers, body, auth: { type: 'none' }, assertions: [],
        scripts: { preRequest: '', postResponse: '' }, protocol: 'http', tags: [], favorite: false, sortOrder: 0,
        settings: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      } as never;
      // http.send returns an envelope { opId, response, preTestResults, postTestResults, assertionResults, ... } (§Kernel).
      const env = asObj(await callAny(registry)('http.send', { request, environmentId, saveHistory: false }));
      const response = asObj((env.response as Record<string, unknown> | undefined) ?? env);
      if (!response.status && response.status !== 0) {
        if (cmd.jsonOutput) { out(env, true); return; }
        fail(`Request failed: ${String(response.errorMessage ?? env.errorMessage ?? 'unknown error')}`);
      }
      if (cmd.jsonOutput) { out(env, true); return; }
      const timing = asObj((response.timing as Record<string, unknown> | undefined) ?? {});
      const totalMs = (response.totalMs ?? timing.totalMs) as number | undefined;
      const sizeBytes = (response.bodySize ?? response.sizeBytes) as number | undefined;
      console.log(`HTTP ${String(response.status)} ${String(response.statusText ?? '')} — ${totalMs != null ? Math.round(totalMs) + 'ms' : '?'}, ${sizeBytes ?? 0}B`);
      // Surface pre-request script failures / assertion failures honestly (§scripts, §assertions).
      const assertFails = ((env.assertionResults as { ok?: boolean }[] | undefined) ?? []).filter((r) => r && r.ok === false);
      if (assertFails.length) console.error(`warnings: ${assertFails.length} assertion(s) failed`);
      if (cmd.includeHeaders) {
        for (const h of (response.headers as { key: string; value: string }[] ?? [])) console.log(`${h.key}: ${h.value}`);
        console.log('');
      }
      const bodyText = String(response.bodyText ?? '');
      if (bodyText) {
        try { console.log(JSON.stringify(JSON.parse(bodyText), null, 2)); } catch { console.log(bodyText); }
      }
    });
  });

// ---------------- run (collection runner) ----------------
program.command('run')
  .description('Run a collection (newman-compatible flags)')
  .argument('<collection>', 'Collection name or id')
  .option('-e, --environment <name>', 'Environment (name or id)')
  .option('-d, --data <file>', 'CSV/JSON data file for iterations')
  .option('-n, --iterations <count>', 'Iteration count', '1')
  .option('--folder <name>', 'Only run a folder')
  .option('--delay <ms>', 'Delay between requests', '0')
  .option('--timeout <ms>', 'Per-request timeout', '60000')
  .option('--stop-on-failure', 'Stop at first failure', false)
  .option('--bail', 'Alias of --stop-on-failure', false)
  .option('--ignore-redirects', 'Do not follow redirects', false)
  .option('--concurrent <n>', 'Concurrent requests', '1')
  .option('-r, --reporters <list>', 'cli,json,junit,html', 'cli')
  .option('--export <file>', 'Write JSON results to file')
  .option('--export-junit <file>', 'Write JUnit XML to file')
  .option('--export-html <file>', 'Write HTML report to file')
  .option('--vault-password <password>', 'Unlock vault before running')
  .action(async (collection: string, cmd: Record<string, string | boolean>) => {
    const exit = await withCtx(async ({ registry }) => {
      const collectionId = await resolveCollectionId(registry, collection);
      const environmentId = await resolveEnvironmentId(registry, cmd.environment as string | undefined);
      let dataRows: Record<string, string>[] | undefined;
      if (cmd.data) {
        const dataset = asObj(await callAny(registry)('dataset.parse', { content: readFileSync(resolve(String(cmd.data)), 'utf8'), format: String(cmd.data).endsWith('.json') ? 'json' : 'csv' }));
        dataRows = dataset.rows as Record<string, string>[];
      }
      const started = await callAny(registry)('run.start', {
        collectionId, environmentId,
        iterations: Number(cmd.iterations ?? 1),
        delayMs: Number(cmd.delay ?? 0),
       timeoutMs: Number(cmd.timeout ?? 60000),
        stopOnFailure: Boolean(cmd.stopOnFailure) || Boolean(cmd.bail),
        concurrency: Number(cmd.concurrent ?? 1),
        dataRows,
      }) as { runId: string };
      const run = await waitRun(registry, started.runId);
      const failed = Number(run.failedRequests ?? 0) > 0 || Number(run.failedTests ?? 0) > 0;
      const outputJson = await callAny(registry)('run.exportJson', { runId: started.runId }) as string;
      if (cmd.export) writeFileSync(resolve(String(cmd.export)), outputJson, 'utf8');
      if (cmd.exportJunit) {
        const xml = await callAny(registry)('run.exportJUnit', { runId: started.runId }) as string;
        writeFileSync(resolve(String(cmd.exportJunit)), xml, 'utf8');
        console.log(`JUnit XML written: ${cmd.exportJunit}`);
      }
      if (cmd.exportHtml) {
        const html = await callAny(registry)('run.exportHtml', { runId: started.runId }) as string;
        writeFileSync(resolve(String(cmd.exportHtml)), html, 'utf8');
        console.log(`HTML report written: ${cmd.exportHtml}`);
      }
      const reporters = String(cmd.reporters ?? 'cli').split(',');
      if (reporters.includes('json') && !cmd.export) writeFileSync('newman-run.json', outputJson, 'utf8'), console.log('JSON results written: newman-run.json');
      if (reporters.includes('junit') && !cmd.exportJunit) writeFileSync('newman-junit.xml', await callAny(registry)('run.exportJUnit', { runId: started.runId }) as string, 'utf8'), console.log('JUnit XML written: newman-junit.xml');
      console.log(`\n${String(run.executedRequests)} executed · ${String(run.passedRequests)} passed · ${String(run.failedRequests)} failed · tests ${String(run.totalTests)} (${String(run.passedTests)}✓/${String(run.failedTests)}✗)`);
      return failed ? 1 : 0;
    }, { vaultPassword: cmd.vaultPassword as string | undefined });
    process.exit(exit);
  });

// ---------------- import / export ----------------
program.command('import')
  .description('Import a file (Postman/OpenAPI/Swagger/WSDL/SOAPUI/HAR/Insomnia/cURL/.http/.env...)')
  .argument('<file>')
  .option('--format <format>', 'Force format detection override')
  .action(async (file: string, cmd: { format?: string }) => {
    await withCtx(async ({ registry }) => {
      const result = asObj(await callAny(registry)('import.run', { path: resolve(file), format: cmd.format }));
      const report = asObj(result.report);
      const cids = (result.collectionIds as string[] | undefined) ?? [];
      console.log(`Imported (${String(report.format)}): ${cids.length} collection(s)`);
      out(result, true);
    });
  });

program.command('export')
  .description('Export a collection or environment')
  .argument('<kind>', 'collection|environment|workspace')
  .argument('<name>', 'Name or id')
  .option('--format <format>', 'postman|apimanager|openapi|dotenv', 'apimanager')
  .option('-o, --output <file>', 'Output file (stdout if omitted)')
  .action(async (kind: string, name: string, cmd: { format: string; output?: string }) => {
    await withCtx(async ({ registry }) => {
      let content: string;
      if (kind === 'collection') {
        content = await callAny(registry)('export.collection', { collectionId: await resolveCollectionId(registry, name), format: cmd.format }) as string;
      } else if (kind === 'environment') {
        const envId = await resolveEnvironmentId(registry, name);
        if (!envId) fail('Environment not found');
        content = await callAny(registry)('export.environment', { environmentId: envId, format: cmd.format === 'apimanager' ? 'apimanager' : cmd.format }) as string;
      } else if (kind === 'workspace') {
        content = await callAny(registry)('export.workspace', {}) as string;
      } else fail(`Unknown kind ${kind} (collection|environment|workspace)`);
      if (cmd.output) { writeFileSync(resolve(cmd.output), content, 'utf8'); console.log(`Exported to ${cmd.output}`); }
      else console.log(content);
    });
  });

program.command('collection')
  .description('List collections')
  .command('list')
  .action(async () => {
    await withCtx(async ({ registry }) => {
      const cols = await callAny(registry)('collection.list', {}) as { id: string; name: string }[];
      for (const c of cols) console.log(`${c.id}  ${c.name}`);
    });
  });

// ---------------- mock ----------------
program.command('mock')
  .description('Manage local mock servers')
  .option('--start <collectionOrMockId>', 'Start mock (stays in foreground)')
  .option('--list', 'List mocks')
  .option('--stop <id>', 'Stop mock')
  .action(async (cmd: { start?: string; list?: boolean; stop?: string }) => {
    if (cmd.list) {
      await withCtx(async ({ registry }) => out(await callAny(registry)('mock.list', {}), true));
      return;
    }
    if (cmd.stop) {
      await withCtx(async ({ registry }) => { await callAny(registry)('mock.stop', { id: cmd.stop }); console.log('Stopped.'); });
      return;
    }
    if (cmd.start) {
      const { handle } = await withCtx(async ({ registry }) => {
        // try mock id first
        const mocks = await callAny(registry)('mock.list', {}) as { id: string; workspaceId: string }[];
        const direct = mocks.find((m) => m.id === cmd.start);
        if (direct) {
          const r = await callAny(registry)('mock.start', { id: direct.id }) as { url?: string };
          console.log(`Mock running at ${r.url} (Ctrl+C to stop)`);
          return { handle: true };
        }
        try {
          const collectionId = await resolveCollectionId(registry, cmd.start!);
          const mock = asObj(await callAny(registry)('mock.fromCollection', { collectionId }));
          const r = asObj(await callAny(registry)('mock.start', { id: String(mock.id) }));
          console.log(`Mock "${String(mock.name)}" running at ${String(r.url)} (Ctrl+C to stop)`);
          return { handle: true };
        } catch (e) { fail(String(e instanceof Error ? e.message : e)); }
        return { handle: true };
      });
      void handle;
      await new Promise(() => undefined); // foreground
    }
  });

// ---------------- monitor ----------------
program.command('monitor')
  .description('Manage monitors')
  .option('--list', 'List monitors')
  .option('--run <id>', 'Run monitor now (blocking)')
  .action(async (cmd: { list?: boolean; run?: string }) => {
    if (cmd.list) await withCtx(async ({ registry }) => out(await callAny(registry)('monitor.list', {}), true));
    else if (cmd.run) await withCtx(async ({ registry }) => out(await callAny(registry)('monitor.runNow', { id: cmd.run }), true));
    else program.help();
  });


async function startPerfTarget(registry: CliCtx['registry'], target: { kind: 'request' | 'collection'; id: string }, cmd: { duration: string; vu: string; rps: string }): Promise<Record<string, unknown>> {
  // PerfConfig (§perf): target/concurrency/ratePerSecond/durationSec/ramp/timeout — NO 'profile' wrapper.
  return asObj(await callAny(registry)('perf.start', {
    target,
    concurrency: Number(cmd.vu) || 2,
    ratePerSecond: Number(cmd.rps) || 0,
    durationSec: Number(cmd.duration) || 10,
    rampUpSec: 0, rampDownSec: 0, timeoutMs: 30000,
  }));
}

async function reportPerf(registry: CliCtx['registry'], runId: string): Promise<void> {
  console.log(`Perf run ${runId} started…`);
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const run = asObj(await callAny(registry)('perf.get', { runId }));
    const state = String(run.status ?? '');
    if (run.metrics || ['completed', 'failed', 'stopped'].includes(state)) {
      if (run.metrics) {
        const m = asObj(run.metrics);
        const r1 = (n: unknown) => (n == null ? '-' : Number(n).toFixed(1));
        console.log(`done: requests=${String(m.totalRequests ?? 0)} ok=${String(m.successCount ?? 0)} errors=${String(m.errorCount ?? 0)} ` +
          `avg=${r1(m.avgMs)}ms p50=${r1(m.p50)}ms p95=${r1(m.p95)}ms p99=${r1(m.p99)}ms ` +
          `rps=${r1(m.throughputPerSec)}`);
      } else {
        console.log(`run finished with status '${state}' (no metrics recorded)`);
      }
      return;
    }
    if (Date.now() > deadline) fail('Perf run did not finish within 10 minutes');
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ---------------- perf ----------------
program.command('perf')
  .description('Quick performance test against a saved request or URL')
  .argument('<requestIdOrUrl>')
  .option('--duration <sec>', 'Duration seconds', '10')
  .option('--vu <n>', 'Virtual users', '2')
  .option('--rps <n>', 'Requests per second cap', '0')
  .action(async (target: string, cmd: { duration: string; vu: string; rps: string }) => {
    await withCtx(async ({ registry }) => {
      const isUrl = target.startsWith('http://') || target.startsWith('https://');
      // Perf targets must be saved requests (PerfConfig.target: request|collection). For ad-hoc
      // URLs we create a temporary GET request, run against it, then remove it again.
      let targetId = target;
      if (isUrl) {
        // request.create takes { name, method, url, workspaceId? } and returns the created request.
        const req = asObj(await callAny(registry)('request.create', { name: `[cli perf temp] ${target}`, method: 'GET', url: target }));
        targetId = String(req.id ?? ''); if (!targetId || targetId === 'undefined') fail('Failed to create temporary request for perf target');
      } else {
        let isRequest = false;
        try { isRequest = Boolean(asObj(await callAny(registry)('request.get', { id: target })).id); } catch { isRequest = false; }
        if (isRequest) targetId = target;
        else {
        // not a request id — try collection name/id
        const cols = await callAny(registry)('collection.list', {}) as { id: string; name: string }[];
        const match = cols.find((c) => c.id === target) ?? cols.find((c) => c.name.toLowerCase() === target.toLowerCase());
        if (!match) fail(`Target not found: ${target} (pass a URL, request id, or collection name/id)`);
        const started2 = asObj(await startPerfTarget(registry, { kind: 'collection', id: match.id }, cmd));
        return await reportPerf(registry, String(started2.runId));
        }
      }
      const started = asObj(await startPerfTarget(registry, { kind: 'request', id: targetId }, cmd));
      try { return await reportPerf(registry, String(started.runId)); }
      finally { if (isUrl) { try { await callAny(registry)('request.delete', { id: targetId }); } catch { /* best effort */ } } }
    });
  });

// ---------------- spec / lint ----------------
program.command('lint')
  .description('Validate an OpenAPI/AsyncAPI/GraphQL/Protobuf spec file')
  .argument('<file>')
  .action(async (file: string) => {
    await withCtx(async ({ registry }) => {
      const res = asObj(await callAny(registry)('spec.validate', { content: readFileSync(resolve(file), 'utf8') }));
      out(res, true);
      const errors = (res.issues as { severity: string }[] ?? []).filter((i) => i.severity === 'error' || i.severity === 'error');
      if (errors.length > 0 || res.valid === false) process.exit(1);
    });
  });

// ---------------- curl ----------------
program.command('curl')
  .description('Convert between cURL and internal request JSON')
  .option('--parse <command>', 'Parse a curl command to request JSON')
  .option('--to-curl <requestId>', 'Generate curl for a saved request')
  .action(async (cmd: { parse?: string; toCurl?: string }) => {
    await withCtx(async ({ registry }) => {
      if (cmd.parse) out(await callAny(registry)('curl.parse', { command: cmd.parse }), true);
      else if (cmd.toCurl) out(await callAny(registry)('curl.generate', { requestId: cmd.toCurl }), false);
      else program.help();
    });
  });

// ---------------- backup ----------------
program.command('backup')
  .description('Backup/restore application data (appdata.db)')
  .option('--create [password]', 'Create backup now (optionally encrypted)')
  .option('--list', 'List backups')
  .option('--restore <file>', 'Restore from backup file')
  .action(async (cmd: { create?: string | boolean; list?: boolean; restore?: string }) => {
    await withCtx(async ({ registry }) => {
      if (cmd.list) { out(await callAny(registry)('backup.list', {}), true); return; }
      if (cmd.create !== undefined) {
        const r = await callAny(registry)('backup.create', { kind: 'manual', encryptPassword: typeof cmd.create === 'string' ? cmd.create : undefined });
        out(r, true); return;
      }
      if (cmd.restore) { out(await callAny(registry)('backup.restore', { path: resolve(cmd.restore) }), true); return; }
      program.help();
    });
  });

// ---------------- vault ----------------
program.command('vault')
  .description('Vault operations (AES-256-GCM at rest)')
  .option('--init <password>', 'Initialize vault with master password')
  .option('--unlock <password>', 'Unlock for this CLI session')
  .option('--set <key=value>', 'Store secret (requires --unlock or cached session)')
  .action(async (cmd: { init?: string; unlock?: string; set?: string }) => {
    await withCtx(async ({ registry }) => {
      if (cmd.init) { await callAny(registry)('vault.initialize', { password: cmd.init }); console.log('Vault initialized.'); }
      if (cmd.unlock) { await callAny(registry)('vault.unlock', { password: cmd.unlock }); console.log('Vault unlocked (this process).'); }
      if (cmd.set) {
        const i = cmd.set.indexOf('=');
        if (i < 0) fail('--set expects key=value');
        await callAny(registry)('vault.set', { name: cmd.set.slice(0, i), secret: cmd.set.slice(i + 1) });
        console.log(`Stored ${cmd.set.slice(0, i)} in vault.`);
      }
    });
  });

// ---------------- misc utilities ----------------
program.command('scan')
  .description('Secret-scan current workspace')
  .action(async () => {
    await withCtx(async ({ registry }) => out(await callAny(registry)('security.scanWorkspace', {}), true));
  });

program.command('ports')
  .description('Show which local ports are occupied/available')
  .argument('[ports...]')
  .action(async () => {
    await withCtx(async ({ registry }) => out(await callAny(registry)('inventory.ports', {}), true));
  });

program.command('hub')
  .description('Start the hub (HTTP+WS bridge + web UI) in foreground')
  .option('--port <port>', 'Port', '7654')
  .option('--token <token>', 'Require auth token')
  .action(async (cmd: { port: string; token?: string }) => {
    const { createContainer } = await import('../runtime/container');
    const { createRegistry } = await import('../runtime/registry');
    const { startHub } = await import('../hub/server');
    const container = await createContainer({ dataDir: dataDirOption() });
    const registry = createRegistry(container);
    const staticDir = [join(process.cwd(), 'dist', 'renderer'), join(process.cwd(), '..', 'dist', 'renderer'), import.meta.dirname ? join(import.meta.dirname, '..', '..', 'dist', 'renderer') : ''].filter(Boolean).find((p) => existsSync(join(p, 'index.html')));
    const handle = await startHub({ container, registry, port: Number(cmd.port), authToken: cmd.token, staticDir, log: (m: string) => console.error(m) });
    console.log(`API Manager hub: ${handle.url}${staticDir ? ' (web UI available)' : ''}`);
  });

// ---------------- run ----------------
program.option('-s, --data-dir <dir>', 'Data directory (default ~/.api-manager)');
program.on('command:*', () => fail(`Unknown command. Run api-manager --help`, 2));

program.parseAsync(process.argv).catch((e) => fail(e instanceof Error ? e.message : String(e)));
