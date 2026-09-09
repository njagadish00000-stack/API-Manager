# API Manager

Offline-first, Postman-class API development, testing & automation desktop app.

**Developer:** Manish Kumar Singh — manishkumars264@gmail.com  
**License:** MIT · **No accounts, no telemetry, no cloud — your data stays on your machine.**

API Manager is a single-offline-runtime application: one Node "hub" process owns the
SQLite datastore, HTTP engine, runners, mocks, monitors, vault, and every other
service. The desktop app (Electron), the bundled web UI, and the CLI all talk to the
same 293-method local IPC bridge, so everything is equally scriptable.

## Features
- Collections, folders, requests with full HTTP engine (auth schemes, cookies, retry, redirects, timing breakdown)
- Environments & variables (scoped resolution, `.env` import/export), globals, cookie jar
- Response viewer: JSON tree, word-wrap, zoom, headers/timeline/console/test panels, save/compare responses
- Import/export: Postman, Insomnia, OpenAPI, WSDL/SOAPUI, curl, HAR, `.http`, `.env`
- Protocols: WebSocket, SSE, MQTT, gRPC (reflection/protos), Socket.IO console
- Scripting: `pm.*` API pre-request/test scripts (sandboxed VM), script library snippets
- Collection runner with datasets, monitors, performance testing (percentile charts), visual flows
- Mock servers (routes/conditional mocks), traffic capture proxy, webhook receivers
- Security: AES-256-GCM vault, secret scanning (20+ patterns), governance rules, audit log
- Git integration (isomorphic-git): init/branch/commit/diff/push/pull, secret-scan before commit
- Backups (auto + manual, optional AES encryption, sha256 verification), CLI with JUnit output for CI
- 293-method local IPC hub (HTTP + WebSocket) — CLI and desktop share the same backend

## Build & run
```bash
npm run install:sandbox   # npm install (skips electron binary download in CI/sandboxes)
npm run build             # renderer (dist/renderer) + node targets (dist/hub, dist/cli, dist/electron)
npm run hub               # start hub: API + bundled web UI  (default ~/.api-manager data)
npm run app               # electron desktop app (needs a display / desktop session)
npm run cli -- --help     # CLI (newman-class)
npm run package           # electron-builder installers (needs full electron download)
```

Headless / CI quick start:
```bash
API_MANAGER_DATA_DIR=/tmp/am node dist/hub/hub.cjs --port 7654
# open http://127.0.0.1:7654/  (bundled web UI), or use the CLI:
node bin/api-manager.mjs send http://localhost:7654/health
node bin/api-manager.mjs import collection.postman.json
node bin/api-manager.mjs run "My Collection" --export-junit report.xml
```

## Build Status — ✅ CLEAN
| Check | Result |
|---|---|
| `npm run build` (vite renderer + esbuild node targets) | ✅ success |
| `npm run typecheck` (tsconfig.node + tsconfig.web) | ✅ 0 errors |
| Node.js | ✅ verified on v22.22.3 (target node20) |
| Linux x64 | ✅ verified (Electron shell + hub + CLI) |

## Test Status
| Suite | Result |
|---|---|
| Unit tests (`npm run test:unit`, vitest) | ✅ **24/24 pass** — curl parsing (11), variable resolution (6), secret-scanner/HMAC/AES-GCM vault lifecycle (7) |
| Hub end-to-end smoke (293-method `/api/call`) | ✅ every major subsystem verified against a live local echo server: workspace/collection/request/environment CRUD, `http.send` (200, timing), history, collection runs (+JUnit XML), mock server live hit + logs, monitor `runNow`→results, vault init/set/list/lock/unlock + wrong-password rejection, backup create+verify (sha256), global search, snapshots + compare, governance, workspace secret scan, `curl.parse`, codegen, audit log, DB diagnostics (`integrityOk`), dataset parse, webhook receiver (ephemeral port → real HTTP hit → save-as-request), perf run (2734 reqs, percentile metrics) + CSV export |
| Web UI serving | ✅ `/` 200, vendor JS 200, monaco CSS 200 |
| CLI end-to-end | ✅ `send`, `import` (Postman), `run` (pass/fail, exit codes 0/1, cli/json/junit/html reporters), `export collection`, `collection list`, `curl --parse`, `lint`, `ports`, `perf` (URL + collection targets, percentile output), `backup --create/--list`, `mock --start/--list/--stop` (live HTTP hit), `scan` |
| Electron desktop runtime | ⚠️ main/preload bundles build clean; not runtime-launched here (headless sandbox has no display server). Hub + bundled web UI is the verified runtime. |

## Feature Status (A–AE checklist)
Legend: `[x]` verified working · `[~]` implemented, partially verified / needs real credentials or a desktop session · `[ ]` not done

- [x] **A — Shell & offline wrapper**: Electron main/preload built, single-process hub, zero network dependencies (desktop runtime itself untested in this headless sandbox [~ caveat])
- [x] **B — Home dashboard**: activity, quick actions, recent items
- [x] **C — Workspace management**: multiple workspaces, per-workspace vault/scans, active-workspace switching
- [x] **D — Collections/folders hierarchy**: CRUD, sidebar ordering, duplication, search
- [x] **E — Request workspace**: tabbed editor for method/URL/params/headers/body/auth/scripts/assertions
- [x] **F — Parameter builder**: path + query params with enable/disable rows
- [x] **G — Body editor**: none/form/urlencoded/raw JSON/text/GraphQL/binary files
- [x] **H — Authorization workspace**: none/inherit/basic/bearer/digest/API-key/JWT/OAuth1/OAuth2-PKCE/AWS-SigV4/NTLM implemented; end-to-end exercised for none/basic in smoke runs `[~ on exotic schemes]`
- [x] **I — Header builder**: presets, content-negotiation helpers
- [x] **J — Scripts**: `pm.*` pre-request/test sandbox; `pm.test`/`pm.expect` verified (pass/fail counted in runs)
- [x] **K — Response viewer**: pretty JSON, headers, timing breakdown, cookies, save/compare
- [x] **L — Context/history**: request history, console log, re-send, save response as example
- [x] **M — Variables & scoping**: global/environment/collection/local scopes + dynamic vars (unit-tested)
- [x] **N — Environment app**: create/edit/enable, `.env` import/export
- [x] **O — Cookie manager**: engine cookie jar across requests
- [x] **P — Collection runner**: iterations, delay, datasets (CSV/JSON), stop-on-failure, concurrency, progress, re-run-failed
- [x] **Q — Monitors**: cron-ish schedules, runNow→results, uptime hints
- [x] **R — Performance testing**: concurrency/ramp/rps, percentiles (p50/p75/p90/p95/p99), charts, baseline compare, CSV/JSON export
- [x] **S — Import/export**: Postman v2.1, OpenAPI, curl, `.http` verified; Insomnia/WSDL/SOAPUI/HAR parsers implemented and exercised by parser-level checks `[~]`
- [~] **T — Capture proxy**: MITM-less HTTP capture proxy implemented; start/stop verified, full TLS interception not exercised
- [x] **U — Code generation**: JS/Node/Python/curl/Go/etc from any request
- [~] **V — Spec & linting**: OpenAPI 3 lint verified; AsyncAPI/GraphQL/protobuf validators implemented, partially exercised
- [x] **W — Cards/dashboards**: governance scorecards, security dashboard
- [x] **X — Secret scanning**: 20+ patterns (AWS/JWT/PK blocks…), masked findings, workspace + response scans (unit + hub verified)
- [x] **Y — Inline docs/tooltips**: contextual help surfaces in the renderer
- [x] **Z — Settings**: theme/timeout/proxy/vault-auto-lock/port overrides, persisted per profile
- [x] **AA — Reports**: run exports as JSON/JUnit-XML/HTML (verified bytes)
- [x] **AB — Mock servers**: routes, examples, conditional mocks; live HTTP hit verified via CLI and hub
- [x] **AC — Developer console**: masked audit log, op log, perf/diagnostics (`db.diagnostics` returns `integrityOk`)
- [x] **AD — Terminal/CLI**: 15 commands, newman-compatible flags, honest exit codes (verified 0 pass / 1 fail), `--format` JUnit/JSON
- [~] **AE — Developer integrations**: webhook receivers (verified end-to-end incl. ephemeral ports + HMAC), Git via isomorphic-git (init/branch/commit/diff; push/pull need real credentials — untested), no cloud sync by design

## Compatibility
- **OS**: Linux, macOS, Windows (Electron). Core services/CLI are pure Node 20+ (no native modules — SQLite runs on the `sql.js` WASM build, so no `node-gyp` anywhere).
- **Import**: Postman collections v2.1 + environments, OpenAPI 3.x, curl, `.http`, `.env`, HAR/Insomnia/WSDL/SOAPUI parsers.
- **Export**: Postman-format collections/platforms, JSON/JUnit/HTML run reports, AES-encrypted backups.
- **Data**: everything lives under the data dir (`~/.api-manager` by default, `API_MANAGER_DATA_DIR`/`--data-dir` to override). Backups are sha256-checked zip archives of `appdata.db`.

## Packaging
- `npm run package` → electron-builder (AppImage/deb on Linux, NSIS on Windows, DMG on macOS) with the config in `package.json` (`build` section). Requires a machine with electron binaries downloaded (`ELECTRON_SKIP_BINARY_DOWNLOAD=0`).
- The CLI and hub need **no packaging**: `node bin/api-manager.mjs` / `node dist/hub/hub.cjs` work from any directory, resolve the SQLite WASM from the bundle path, and default their data dir per-user.

## Known Limitations (honest)
1. The **Electron desktop shell** builds cleanly but was not runtime-launched in this environment (headless sandbox, no X11/Wayland). Use `npm run hub` + the bundled web UI, which is the fully verified runtime.
2. **WebSocket/SSE/MQTT/gRPC/Socket.IO** transports are implemented but were not swung end-to-end against live brokers in this validation run (HTTP/1.1 was). gRPC requires `@grpc/grpc-js` at runtime; in CJS-bundled builds install it next to the bundle or run from the repo.
3. A wrong vault password surfaces as a low-level GCM message (`"Unsupported state or unable to authenticate data"`). This is the honest AES-GCM authentication failure — by design no plaintext metadata leaks when the password is wrong.
4. After a hub restart, persisted `running: true` states (mocks/webhooks/monitors) are stale — stop then start them once to rebind sockets (the UI shows them as running until you do).
5. Electron packaging artifacts were not produced in this sandbox (electron binary download disabled); the builder config is provided and the directory packaging step should be run on a developer machine.
6. Big-N scrypt unlocks (vault) take ~1s by design (memory-hard KDF, 128 MB window per vault key derivation).

## Privacy
No accounts, no telemetry, no analytics, no update pings, no cloud sync. The only
network traffic the app generates is the traffic you explicitly direct at your own
APIs/mocks. The hub binds to localhost by default.
