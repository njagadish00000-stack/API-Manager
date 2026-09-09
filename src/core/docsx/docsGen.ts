/**
 * Offline documentation generator (§65). Produces a self-contained HTML page
 * with navigation tree, search, examples, and version info.
 */
import type { ApiRequest, Collection, Folder, RequestExample, Specification } from '../../shared/types';
import { escapeXml } from '../xmlx/xmlUtils';

const esc = escapeXml;

export interface DocsInput {
  title: string;
  version?: string;
  description?: string;
  collections?: { collection: Collection; folders: Folder[]; requests: ApiRequest[]; examples: RequestExample[] }[];
  specs?: Specification[];
  theme?: 'light' | 'dark';
  customCss?: string;
  markdownToHtml?: (md: string) => string;
  generatedBy?: string;
}

export function generateDocsHtml(input: DocsInput): string {
  const theme = input.theme ?? 'dark';
  const md = input.markdownToHtml ?? ((s: string) => `<p>${esc(s).replace(/\n/g, '<br/>')}</p>`);
  const nav: string[] = [];
  const sections: string[] = [];

  for (const c of input.collections ?? []) {
    const colAnchor = `col-${c.collection.id}`;
    nav.push(`<li><a href="#${colAnchor}">${esc(c.collection.name)}</a><ul>${c.requests.slice(0, 100).map((r) => `<li><a href="#req-${r.id}"><span class="method m-${r.method.toLowerCase()}">${esc(r.method)}</span> ${esc(r.name)}</a></li>`).join('')}</ul></li>`);
    const reqHtml: string[] = [];
    for (const r of c.requests.slice(0, 500)) {
      const examples = c.examples.filter((e) => e.requestId === r.id);
      reqHtml.push(`
        <section class="request" id="req-${r.id}">
          <h3><span class="method m-${r.method.toLowerCase()}">${esc(r.method)}</span> ${esc(r.name)}</h3>
          <div class="url"><code>${esc(r.url)}</code></div>
          ${r.description ? `<div class="desc">${md(r.description)}</div>` : ''}
          ${r.headers.filter((h) => h.enabled).length ? `<h4>Headers</h4><table><tr><th>Name</th><th>Value</th></tr>${r.headers.filter((h) => h.enabled).map((h) => `<tr><td>${esc(h.key)}</td><td><code>${esc(maskIfAuth(h))}</code></td></tr>`).join('')}</table>` : ''}
          ${r.queryParams.filter((q) => q.enabled).length ? `<h4>Query parameters</h4><table><tr><th>Name</th><th>Value</th><th>Description</th></tr>${r.queryParams.filter((q) => q.enabled).map((q2) => `<tr><td>${esc(q2.key)}</td><td><code>${esc(q2.value)}</code></td><td>${esc(q2.description ?? '')}</td></tr>`).join('')}</table>` : ''}
          ${authDoc(r)}
          ${r.body.type !== 'none' && r.body.raw ? `<h4>Request body <span class="badge">${esc(r.body.type)}</span></h4><pre><code>${esc(r.body.raw)}</code></pre>` : ''}
          ${r.body.type === 'graphql' ? `<h4>GraphQL</h4><pre><code>${esc(r.body.graphql?.query ?? '')}</code></pre>${r.body.graphql?.variables ? `<h4>Variables</h4><pre><code>${esc(r.body.graphql.variables)}</code></pre>` : ''}` : ''}
          ${examples.length ? `<h4>Examples</h4>${examples.map((e) => `<div class="example"><h5>${esc(e.name)}</h5><pre><code>HTTP ${e.response?.status ?? ''} ${esc(e.response?.statusText ?? '')}</code></pre>${e.response?.bodyText ? `<pre><code>${esc(trunc(e.response.bodyText, 4000))}</code></pre>` : ''}</div>`).join('')}` : ''}
        </section>`);
    }
    sections.push(`
      <section class="collection" id="${colAnchor}">
        <h2>${esc(c.collection.name)}</h2>
        ${c.collection.description ? `<div class="desc">${md(c.collection.description)}</div>` : ''}
        ${reqHtml.join('\n')}
      </section>`);
  }

  for (const s of input.specs ?? []) {
    const anchor = `spec-${s.id}`;
    nav.push(`<li><a href="#${anchor}">${esc(s.name)} <span class="badge">${esc(s.format)}</span></a></li>`);
    sections.push(`
      <section class="spec" id="${anchor}">
        <h2>${esc(s.name)} <span class="badge">${esc(s.format)} ${esc(s.lifecycle)}</span></h2>
        <pre class="spec-content"><code>${esc(trunc(s.content, 60_000))}</code></pre>
      </section>`);
  }

  return `<!DOCTYPE html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8"/>
<title>${esc(input.title)} — API Documentation</title>
<meta name="generator" content="${esc(input.generatedBy ?? 'API Manager')}"/>
<style>
:root[data-theme=dark]{--bg:#0d1117;--bg2:#161b22;--fg:#e6edf3;--muted:#8b949e;--accent:#58a6ff;--border:#30363d}
:root[data-theme=light]{--bg:#ffffff;--bg2:#f6f8fa;--fg:#1f2328;--muted:#59636e;--accent:#0969da;--border:#d1d9e0}
*{box-sizing:border-box}
body{margin:0;display:flex;font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
nav{width:300px;min-height:100vh;border-right:1px solid var(--border);padding:16px;position:sticky;top:0;height:100vh;overflow:auto;background:var(--bg2)}
nav input{width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);margin-bottom:12px}
nav ul{list-style:none;padding-left:12px}nav li{margin:2px 0}nav a{color:var(--muted);text-decoration:none}nav a:hover{color:var(--accent)}
main{flex:1;padding:32px;max-width:980px}
h1{font-size:28px}h2{border-bottom:1px solid var(--border);padding-bottom:8px;font-size:22px}
.method{font:600 11px/1 monospace;padding:3px 7px;border-radius:4px;display:inline-block;min-width:52px;text-align:center}
.m-get{background:#0d4429;color:#7ee2a8}.m-post{background:#123c61;color:#79c0ff}.m-put{background:#4a2c0e;color:#ffab70}.m-patch{background:#3a1f5d;color:#d2a8ff}.m-delete{background:#5d1f1f;color:#ff7f8a}.m-head,.m-options,.m-trace{background:#30363d;color:#adb6c2}
.url{background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-family:monospace;overflow-x:auto}
pre{background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:12px;overflow-x:auto;font-size:12.5px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid var(--border);padding:6px 10px;text-align:left;font-size:12.5px}th{background:var(--bg2)}
.badge{background:var(--bg2);border:1px solid var(--border);border-radius:20px;padding:2px 10px;font-size:12px;color:var(--muted)}
.desc{color:var(--muted)}
.request{margin-bottom:40px}
.hidden{display:none}
${input.customCss ?? ''}
</style>
</head>
<body>
<nav>
  <h1 style="font-size:18px">📘 ${esc(input.title)}</h1>
  <input id="search" placeholder="Search documentation…" oninput="filterDocs(this.value)"/>
  <ul id="nav">${nav.join('\n')}</ul>
</nav>
<main>
  <h1>${esc(input.title)}</h1>
  ${input.version ? `<p class="badge">Version ${esc(input.version)}</p>` : ''}
  ${input.description ? `<div class="desc">${md(input.description)}</div>` : ''}
  <p class="desc">Generated ${new Date().toISOString()} by ${esc(input.generatedBy ?? 'API Manager')} — fully offline.</p>
  ${sections.join('\n') || '<p>No content.</p>'}
</main>
<script>
function filterDocs(q){
  q = q.toLowerCase();
  document.querySelectorAll('section.request').forEach(function(s){
    s.classList.toggle('hidden', q && !s.textContent.toLowerCase().includes(q));
  });
  document.querySelectorAll('#nav a').forEach(function(a){
    a.parentElement.classList.toggle('hidden', q && !a.textContent.toLowerCase().includes(q));
  });
}
</script>
</body>
</html>`;
}

function maskIfAuth(h: { key: string; value: string }): string {
  if (['authorization', 'x-api-key', 'api-key', 'proxy-authorization'].includes(h.key.toLowerCase())) {
    return h.value.length > 8 ? `${h.value.slice(0, 4)}••••••••` : '••••••••';
  }
  return h.value;
}

function authDoc(r: ApiRequest): string {
  const t = r.auth?.type;
  if (!t || t === 'none') return '';
  const names: Record<string, string> = { basic: 'Basic Auth', bearer: 'Bearer Token', apikey: 'API Key', digest: 'Digest', oauth1: 'OAuth 1.0', oauth2: 'OAuth 2.0', jwt: 'JWT', aws4: 'AWS Signature V4', inherit: 'Inherited', ntlm: 'NTLM', hawk: 'Hawk' };
  return `<h4>Authentication</h4><p class="desc">${esc(names[t] ?? t)}${t === 'inherit' ? ' (from parent)' : ''}</p>`;
}

function trunc(s: string, n: number): string { return s.length > n ? `${s.slice(0, n)}\n… truncated…` : s; }
