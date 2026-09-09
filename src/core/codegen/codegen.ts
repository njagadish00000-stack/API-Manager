/**
 * Code generation (§85). Generates client code for many languages from a
 * fully-resolved request + final headers/URL.
 */
import type { ApiRequest, KeyValue } from '../../shared/types';
import { buildUrl } from '../url/urlBuilder';
import { generateCurl } from '../curl/curlGenerator';

export interface CodegenTargetSpec { language: string; label: string; variants: { id: string; label: string }[] }

export const CODEGEN_TARGETS: CodegenTargetSpec[] = [
  { language: 'curl', label: 'cURL', variants: [{ id: 'curl', label: 'cURL' }] },
  { language: 'python', label: 'Python', variants: [{ id: 'requests', label: 'requests' }, { id: 'httpx', label: 'httpx' }] },
  { language: 'java', label: 'Java', variants: [{ id: 'okhttp', label: 'OkHttp' }, { id: 'httpclient', label: 'Java 11 HttpClient' }, { id: 'webclient', label: 'Spring WebClient' }, { id: 'retrofit', label: 'Retrofit' }] },
  { language: 'javascript', label: 'JavaScript', variants: [{ id: 'fetch', label: 'fetch' }, { id: 'axios', label: 'Axios' }, { id: 'xhr', label: 'XMLHttpRequest' }] },
  { language: 'node', label: 'Node.js', variants: [{ id: 'fetch', label: 'fetch (Node 18+)' }, { id: 'axios', label: 'Axios' }, { id: 'http', label: 'node:http' }] },
  { language: 'typescript', label: 'TypeScript', variants: [{ id: 'fetch', label: 'fetch (typed)' }] },
  { language: 'csharp', label: 'C#', variants: [{ id: 'httpclient', label: 'HttpClient' }, { id: 'restsharp', label: 'RestSharp' }] },
  { language: 'go', label: 'Go', variants: [{ id: 'http', label: 'net/http' }] },
  { language: 'php', label: 'PHP', variants: [{ id: 'curl', label: 'cURL' }, { id: 'guzzle', label: 'Guzzle' }] },
  { language: 'ruby', label: 'Ruby', variants: [{ id: 'net-http', label: 'Net::HTTP' }] },
  { language: 'kotlin', label: 'Kotlin', variants: [{ id: 'okhttp', label: 'OkHttp' }] },
  { language: 'swift', label: 'Swift', variants: [{ id: 'urlsession', label: 'URLSession' }] },
  { language: 'rust', label: 'Rust', variants: [{ id: 'reqwest', label: 'reqwest' }] },
  { language: 'scala', label: 'Scala', variants: [{ id: 'sttp', label: 'sttp' }] },
  { language: 'r', label: 'R', variants: [{ id: 'httr', label: 'httr' }] },
  { language: 'elixir', label: 'Elixir', variants: [{ id: 'req', label: 'Req' }] },
  { language: 'objc', label: 'Objective-C', variants: [{ id: 'nsurlsession', label: 'NSURLSession' }] },
];

export interface PreparedRequest {
  method: string;
  url: string;
  headers: KeyValue[];
  bodyText?: string;
  bodyIsBinary?: boolean;
  formFields?: { key: string; value?: string; file?: string; mime?: string }[];
  urlencoded?: [string, string][];
}

export function prepare(request: ApiRequest, finalHeaders?: KeyValue[], finalUrl?: string, finalBody?: string): PreparedRequest {
  const headers = (finalHeaders ?? request.headers ?? []).filter((h) => h.enabled && h.key);
  const url = finalUrl ?? buildUrl(request.url, request.queryParams ?? []);
  const b = request.body;
  const out: PreparedRequest = { method: request.method.toUpperCase(), url, headers: [...headers] };
  const contentType = headers.find((h) => h.key.toLowerCase() === 'content-type')?.value;
  switch (b?.type) {
    case 'json': case 'xml': case 'html': case 'javascript': case 'text':
      out.bodyText = finalBody ?? b.raw ?? undefined;
      if (!contentType && b.type === 'json') out.headers.push({ id: 'ct', key: 'Content-Type', value: 'application/json', enabled: true });
      break;
    case 'graphql': {
      out.bodyText = JSON.stringify({ query: b.graphql?.query ?? '', variables: tryParse(b.graphql?.variables ?? '{}') });
      out.headers.push({ id: 'ct', key: 'Content-Type', value: 'application/json', enabled: true });
      break;
    }
    case 'urlencoded':
      out.urlencoded = (b.urlencoded ?? []).filter((p) => p.enabled && p.key).map((p) => [p.key, p.value]);
      if (!contentType) out.headers.push({ id: 'ct', key: 'Content-Type', value: 'application/x-www-form-urlencoded', enabled: true });
      break;
    case 'form-data':
      out.formFields = (b.formData ?? []).filter((f) => f.enabled && f.key).map((f) => ({
        key: f.key, value: f.fieldType === 'file' ? undefined : f.value,
        file: f.fieldType === 'file' ? f.filePath ?? f.value : undefined, mime: f.mimeType,
      }));
      break;
    case 'binary': case 'file':
      out.bodyIsBinary = true;
      out.bodyText = b.binaryFilePath;
      break;
  }
  // auth → headers (light, the engine does full signing at send time)
  const a = request.auth;
  if (a?.type === 'basic' && a.basic) out.headers.push({ id: 'a', key: 'Authorization', value: `Basic ${btoaLite(`${a.basic.username}:${a.basic.password}`)}`, enabled: true });
  if (a?.type === 'bearer' && a.bearer?.token) out.headers.push({ id: 'a', key: 'Authorization', value: `${a.bearer.prefix ?? 'Bearer'} ${a.bearer.token}`, enabled: true });
  if (a?.type === 'oauth2' && a.oauth2?.accessToken) out.headers.push({ id: 'a', key: 'Authorization', value: `Bearer ${a.oauth2.accessToken}`, enabled: true });
  if (a?.type === 'apikey' && a.apikey && a.apikey.addTo === 'header') out.headers.push({ id: 'a', key: a.apikey.key, value: a.apikey.value, enabled: true });
  if (a?.type === 'apikey' && a.apikey && a.apikey.addTo === 'query') out.url = `${url}${url.includes('?') ? '&' : '?'}${encodeURIComponent(a.apikey.key)}=${encodeURIComponent(a.apikey.value)}`;
  return out;
}

function btoaLite(s: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) { const c = s.codePointAt(i)!; if (c < 128) bytes.push(c); else if (c < 2048) { bytes.push(192 | (c >> 6), 128 | (c & 63)); } else { bytes.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63)); } }
  for (let i = 0; i < bytes.length; i += 3) {
    const [b0, b1, b2] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    out += chars[b0 >> 2] + chars[((b0 & 3) << 4) | ((isNaN(b1) ? 0 : b1) >> 4)];
    out += isNaN(b1) ? '=' : chars[((b1 & 15) << 2) | ((isNaN(b2) ? 0 : b2) >> 6)];
    out += isNaN(b2) ? '=' : chars[b2 & 63];
  }
  return out;
}

function tryParse(s: string): unknown { try { return JSON.parse(s); } catch { return s; } }

const q = {
  py: (s: string) => `"""${s.replace(/"""/g, '\\"\\"\\"')}"""`,
  str: (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
  tmpl: (s: string) => '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`',
  raw: (s: string) => `@"${s.replace(/"/g, '""')}"`,
  go: (s: string) => '`' + s.replace(/`/g, '` + "`" + `') + '`',
  php: (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`,
  rb: (s: string) => `<<~BODY\n${s}\nBODY`,
};

function headersCommentOutFormDataBoundary(p: PreparedRequest): KeyValue[] {
  return p.headers.filter((h) => !(p.formFields && h.key.toLowerCase() === 'content-type'));
}

export function generateCode(request: ApiRequest, language: string, variant?: string, prepared?: PreparedRequest): string {
  if (language === 'curl') return generateCurl({ request });
  const p = prepared ?? prepare(request);
  const v = variant ?? CODEGEN_TARGETS.find((t) => t.language === language)?.variants[0].id ?? '';
  const headers = headersCommentOutFormDataBoundary(p);
  const hs = (tpl: (h: KeyValue) => string) => headers.map(tpl).filter(Boolean).join('');

  switch (`${language}:${v}`) {
    case 'python:requests': {
      let code = `import requests\n\nurl = ${q.py(p.url)}\n`;
      if (headers.length) code += `headers = {\n${headers.map((h) => `    ${q.py(h.key)}: ${q.py(h.value)},`).join('\n')}\n}\n`;
      if (p.bodyText && !p.bodyIsBinary) code += `payload = ${q.py(p.bodyText)}\n`;
      if (p.urlencoded) code += `payload = ${JSON.stringify(Object.fromEntries(p.urlencoded), null, 4)}\n`;
      if (p.formFields) {
        code += `files = {\n${p.formFields.map((f) => f.file ? `    ${q.py(f.key)}: (${q.py(f.file)}, open(${q.py(f.file)}, 'rb')${f.mime ? `, ${q.py(f.mime)}` : ''})` : `    ${q.py(f.key)}: (None, ${q.py(f.value ?? '')})`).join(',\n')}\n}\n`;
      }
      code += `\nresponse = requests.request(${q.py(p.method)}, url${headers.length ? ', headers=headers' : ''}`;
      if (p.bodyText && !p.bodyIsBinary) code += `, data=payload`;
      if (p.urlencoded) code += `, data=payload`;
      if (p.formFields) code += `, files=files`;
      if (p.bodyIsBinary && p.bodyText) code += `, files={'file': open(${q.py(p.bodyText)}, 'rb')}`.replace('files', 'data') + '';
      code += `)\n\nprint(response.status_code)\nprint(response.text)\n`;
      return code;
    }
    case 'python:httpx': {
      let code = `import httpx\n\nurl = ${q.py(p.url)}\n`;
      if (headers.length) code += `headers = {\n${headers.map((h) => `    ${q.py(h.key)}: ${q.py(h.value)},`).join('\n')}\n}\n`;
      if (p.bodyText && !p.bodyIsBinary) code += `payload = ${q.py(p.bodyText)}\n`;
      code += `\nwith httpx.Client() as client:\n    response = client.request(${q.py(p.method)}, url${headers.length ? ', headers=headers' : ''}${p.bodyText && !p.bodyIsBinary ? ', content=payload' : ''}${p.urlencoded ? `, data=${JSON.stringify(Object.fromEntries(p.urlencoded))}` : ''})\n    print(response.status_code)\n    print(response.text)\n`;
      return code;
    }
    case 'java:okhttp': case 'kotlin:okhttp': {
      const isKt = language === 'kotlin';
      const bodyType = p.bodyText && headers.find((h) => h.key.toLowerCase() === 'content-type')?.value || (p.bodyText ? 'text/plain; charset=utf-8' : undefined);
      let code = isKt
        ? `import okhttp3.*\nimport okhttp3.MediaType.Companion.toMediaType\nimport okhttp3.RequestBody.Companion.toRequestBody\n\nval client = OkHttpClient()\n\n`
        : `import okhttp3.*;\n\nOkHttpClient client = new OkHttpClient();\n\n`;
      if (p.formFields) {
        code += isKt ? `val body = MultipartBody.Builder()\n    .setType(MultipartBody.FORM)\n` : `RequestBody body = new MultipartBody.Builder()\n    .setType(MultipartBody.FORM)\n`;
        for (const f of p.formFields) {
          code += f.file
            ? (isKt ? `    .addFormDataPart(${q.str(f.key)}, ${q.str(f.file)},\n        File(${q.str(f.file)}).asRequestBody(${(f.mime ? q.str(f.mime) : '"application/octet-stream"')}.toMediaType()))\n` : `    .addFormDataPart(${q.str(f.key)}, ${q.str(f.file)},\n        RequestBody.create(new File(${q.str(f.file)}), MediaType.parse(${q.str(f.mime ?? 'application/octet-stream')})))\n`)
            : (isKt ? `    .addFormDataPart(${q.str(f.key)}, ${q.str(f.value ?? '')})\n` : `    .addFormDataPart(${q.str(f.key)}, ${q.str(f.value ?? '')})\n`);
        }
        code += isKt ? `    .build()\n\n` : `    .build();\n\n`;
      } else if (p.bodyText && !p.bodyIsBinary) {
        code += isKt
          ? `val body = ${q.str(p.bodyText)}.toRequestBody(${q.str(bodyType!)}.toMediaType())\n\n`
          : `MediaType mediaType = MediaType.parse(${q.str(bodyType!)});\nRequestBody body = RequestBody.create(${q.str(p.bodyText)}, mediaType);\n\n`;
      } else if (p.urlencoded) {
        code += isKt ? `val body = FormBody.Builder()\n` : `RequestBody body = new FormBody.Builder()\n`;
        for (const [k, val] of p.urlencoded) code += `    .add(${q.str(k)}, ${q.str(val)})\n`;
        code += isKt ? `    .build()\n\n` : `    .build();\n\n`;
      }
      code += isKt ? `val request = Request.Builder()\n    .url(${q.str(p.url)})\n    .method(${q.str(p.method)}, ${p.method === 'GET' || p.method === 'HEAD' ? 'null' : 'body'})\n` : `Request request = new Request.Builder()\n    .url(${q.str(p.url)})\n    .method(${q.str(p.method)}, ${p.method === 'GET' || p.method === 'HEAD' ? 'null' : 'body'})\n`;
      for (const h of headers) code += `    .addHeader(${q.str(h.key)}, ${q.str(h.value)})\n`;
      code += isKt ? `    .build()\nval response = client.newCall(request).execute()\nprintln(response.body?.string())\n` : `    .build();\nResponse response = client.newCall(request).execute();\nSystem.out.println(response.body().string());\n`;
      return code;
    }
    case 'java:httpclient': {
      let code = `import java.net.URI;\nimport java.net.http.*;\n\nHttpClient client = HttpClient.newHttpClient();\nHttpRequest.Builder builder = HttpRequest.newBuilder()\n    .uri(URI.create(${q.str(p.url)}))\n    .method(${q.str(p.method)}, `;
      code += p.bodyText && !p.bodyIsBinary ? `HttpRequest.BodyPublishers.ofString(${q.str(p.bodyText)}))\n` : `HttpRequest.BodyPublishers.noBody())\n`;
      for (const h of headers) code += `    .header(${q.str(h.key)}, ${q.str(h.value)})\n`;
      code += `;\nHttpResponse<String> response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString());\nSystem.out.println(response.statusCode());\nSystem.out.println(response.body());\n`;
      return code;
    }
    case 'java:webclient': {
      return `WebClient client = WebClient.create();\n\nString response = client.method(HttpMethod.${p.method})\n    .uri(${q.str(p.url)})\n${headers.map((h) => `    .header(${q.str(h.key)}, ${q.str(h.value)})\n`).join('')}${p.bodyText && !p.bodyIsBinary ? `    .bodyValue(${q.str(p.bodyText)})\n` : ''}    .retrieve()\n    .bodyToMono(String.class)\n    .block();\nSystem.out.println(response);\n`;
    }
    case 'java:retrofit': {
      return `public interface ApiService {\n    @${p.method}("${new URLsafe(p.url).path}")\n    Call<ResponseBody> run(${p.bodyText && !p.bodyIsBinary ? `\n        @Body RequestBody body,` : ''}${headers.length ? headers.map((h) => `\n        @Header(${q.str(h.key)}) String ${sanitize(h.key)}`).join(',') : ''}\n    );\n}\n\n// usage: see Retrofit builder with baseUrl "${new URLsafe(p.url).base}"\n`;
    }
    case 'javascript:fetch': case 'node:fetch': {
      let code = `const url = ${q.str(p.url)};\n\nconst options = {\n  method: ${q.str(p.method)},\n`;
      if (headers.length) code += `  headers: {\n${headers.map((h) => `    ${q.str(h.key)}: ${q.str(h.value)},`).join('\n')}\n  },\n`;
      if (p.bodyText && !p.bodyIsBinary) code += `  body: ${q.str(p.bodyText)},\n`;
      if (p.urlencoded) code += `  body: new URLSearchParams(${JSON.stringify(Object.fromEntries(p.urlencoded))}),\n`;
      if (p.formFields) {
        code += `  body: (() => {\n    const form = new FormData();\n${p.formFields.map((f) => f.file ? `    form.append(${q.str(f.key)}, new Blob([await Deno.readFile(${q.str(f.file)})]) /* or fs file */, ${q.str(f.file)});` : `    form.append(${q.str(f.key)}, ${q.str(f.value ?? '')});`).join('\n')}\n    return form;\n  })(),\n`;
      }
      code += `};\n\nconst response = await fetch(url, options);\nconsole.log(response.status);\nconsole.log(await response.text());\n`;
      return code;
    }
    case 'typescript:fetch': {
      let code = `interface ApiResponse<T = unknown> { status: number; body: T }\n\nasync function callApi(): Promise<ApiResponse<string>> {\n  const response = await fetch(${q.str(p.url)}, {\n    method: ${q.str(p.method)},\n`;
      if (headers.length) code += `    headers: {\n${headers.map((h) => `      ${q.str(h.key)}: ${q.str(h.value)},`).join('\n')}\n    },\n`;
      if (p.bodyText && !p.bodyIsBinary) code += `    body: ${q.str(p.bodyText)},\n`;
      if (p.urlencoded) code += `    body: new URLSearchParams(${JSON.stringify(Object.fromEntries(p.urlencoded))}).toString(),\n`;
      code += `  });\n  return { status: response.status, body: await response.text() };\n}\n\ncallApi().then((r) => console.log(r.status, r.body));\n`;
      return code;
    }
    case 'javascript:axios': case 'node:axios': {
      const isNode = language === 'node';
      let code = isNode ? `const axios = require('axios');\n\n` : `import axios from 'axios';\n\n`;
      code += `const response = await axios({\n  method: ${q.str(p.method)},\n  url: ${q.str(p.url)},\n`;
      if (headers.length) code += `  headers: {\n${headers.map((h) => `    ${q.str(h.key)}: ${q.str(h.value)},`).join('\n')}\n  },\n`;
      if (p.bodyText && !p.bodyIsBinary) code += `  data: ${q.str(p.bodyText)},\n`;
      if (p.urlencoded) code += `  data: new URLSearchParams(${JSON.stringify(Object.fromEntries(p.urlencoded))}).toString(),\n`;
      code += `});\nconsole.log(response.status, response.data);\n`;
      return code;
    }
    case 'javascript:xhr': {
      return `const xhr = new XMLHttpRequest();\nxhr.open(${q.str(p.method)}, ${q.str(p.url)});\n${headers.map((h) => `xhr.setRequestHeader(${q.str(h.key)}, ${q.str(h.value)});\n`).join('')}xhr.onload = () => console.log(xhr.status, xhr.responseText);\nxhr.send(${p.bodyText && !p.bodyIsBinary ? q.str(p.bodyText) : ''});\n`;
    }
    case 'node:http': {
      const u = new URLsafe(p.url);
      return `const ${u.isHttps ? 'https' : 'http'} = require('${u.isHttps ? 'https' : 'http'}');\n\nconst options = {\n  hostname: ${q.str(u.hostname)},\n  port: ${u.port || (u.isHttps ? 443 : 80)},\n  path: ${q.str(u.path)},\n  method: ${q.str(p.method)},\n  headers: {\n${headers.map((h) => `    ${q.str(h.key)}: ${q.str(h.value)},`).join('\n')}\n  },\n};\n\nconst req = ${u.isHttps ? 'https' : 'http'}.request(options, (res) => {\n  let body = '';\n  res.on('data', (chunk) => (body += chunk));\n  res.on('end', () => console.log(res.statusCode, body));\n});\n${p.bodyText && !p.bodyIsBinary ? `req.write(${q.str(p.bodyText)});\n` : ''}req.end();\n`;
    }
    case 'csharp:httpclient': {
      return `using System.Net.Http;\nusing System.Text;\n\nusing var client = new HttpClient();\nusing var request = new HttpRequestMessage(HttpMethod.${pascal(p.method)}, ${q.str(p.url)});\n${headers.map((h) => `request.Headers.TryAddWithoutValidation(${q.str(h.key)}, ${q.str(h.value)});\n`).join('')}${p.bodyText && !p.bodyIsBinary ? `request.Content = new StringContent(${q.str(p.bodyText)}, Encoding.UTF8, ${q.str(headers.find((h) => h.key.toLowerCase() === 'content-type')?.value.split(';')[0] ?? 'text/plain')});\n` : ''}using var response = await client.SendAsync(request);\nConsole.WriteLine((int)response.StatusCode);\nConsole.WriteLine(await response.Content.ReadAsStringAsync());\n`;
    }
    case 'csharp:restsharp': {
      return `using RestSharp;\n\nvar client = new RestClient(${q.str(p.url)});\nvar request = new RestRequest(string.Empty, Method.${pascal(p.method)});\n${headers.map((h) => `request.AddHeader(${q.str(h.key)}, ${q.str(h.value)});\n`).join('')}${p.bodyText && !p.bodyIsBinary ? `request.AddStringBody(${q.str(p.bodyText)}, DataFormat.None);\n` : ''}var response = await client.ExecuteAsync(request);\nConsole.WriteLine((int)response.StatusCode);\nConsole.WriteLine(response.Content);\n`;
    }
    case 'go:http': {
      const u = new URLsafe(p.url);
      const needsBody = p.bodyText && !p.bodyIsBinary;
      return `package main\n\nimport (\n	"fmt"\n	"io"\n	"net/http"${needsBody ? '\n	"strings"' : ''}\n)\n\nfunc main() {\n	url := ${q.str(p.url)}\n	method := ${q.str(p.method)}\n\n${needsBody ? `	payload := strings.NewReader(${q.go(p.bodyText ?? '')})\n` : ''}	client := &http.Client{}\n	req, err := http.NewRequest(method, url, ${needsBody ? 'payload' : 'nil'})\n	if err != nil {\n		panic(err)\n	}\n${headers.map((h) => `	req.Header.Add(${q.str(h.key)}, ${q.str(h.value)})\n`).join('')}	res, err := client.Do(req)\n	if err != nil {\n		panic(err)\n	}\n	defer res.Body.Close()\n	body, _ := io.ReadAll(res.Body)\n	fmt.Println(res.StatusCode)\n	fmt.Println(string(body))\n	_ = "${u.hostname}"\n}\n`;
    }
    case 'php:curl': {
      return `<?php\n$ch = curl_init();\n\ncurl_setopt_array($ch, [\n    CURLOPT_URL => ${q.php(p.url)},\n    CURLOPT_RETURNTRANSFER => true,\n    CURLOPT_CUSTOMREQUEST => ${q.php(p.method)},\n${headers.length ? `    CURLOPT_HTTPHEADER => [\n${headers.map((h) => `        ${q.php(`${h.key}: ${h.value}`)},`).join('\n')}\n    ],\n` : ''}${p.bodyText && !p.bodyIsBinary ? `    CURLOPT_POSTFIELDS => ${q.php(p.bodyText)},\n` : ''}]);\n\n$response = curl_exec($ch);\n$status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);\ncurl_close($ch);\n\necho $status, "\\n", $response;\n`;
    }
    case 'php:guzzle': {
      return `<?php\nuse GuzzleHttp\\Client;\n\n$client = new Client();\n$response = $client->request(${q.php(p.method)}, ${q.php(p.url)}, [\n${headers.length ? `    'headers' => [\n${headers.map((h) => `        ${q.php(h.key)} => ${q.php(h.value)},`).join('\n')}\n    ],\n` : ''}${p.bodyText && !p.bodyIsBinary ? `    'body' => ${q.php(p.bodyText)},\n` : ''}]);\n\necho $response->getStatusCode(), "\\n", $response->getBody();\n`;
    }
    case 'ruby:net-http': {
      const u = new URLsafe(p.url);
      return `require 'uri'\nrequire 'net/http'\n\nuri = URI(${q.str(p.url)})\nhttp = Net::HTTP.new(uri.host, uri.port)\nhttp.use_ssl = ${u.isHttps}\n\nrequest = Net::HTTP::${pascal(p.method)}.new(uri)\n${headers.map((h) => `request[${q.str(h.key)}] = ${q.str(h.value)}\n`).join('')}${p.bodyText && !p.bodyIsBinary ? `request.body = ${q.rb(p.bodyText ?? '')}\n` : ''}response = http.request(request)\nputs response.code\nputs response.body\n`;
    }
    case 'swift:urlsession': {
      return `import Foundation\n\nvar request = URLRequest(url: URL(string: ${q.str(p.url)})!)\nrequest.httpMethod = ${q.str(p.method)}\n${headers.map((h) => `request.setValue(${q.str(h.value)}, forHTTPHeaderField: ${q.str(h.key)})\n`).join('')}${p.bodyText && !p.bodyIsBinary ? `request.httpBody = ${q.str(p.bodyText)}.data(using: .utf8)\n` : ''}\nlet task = URLSession.shared.dataTask(with: request) { data, response, error in\n    guard let data = data, let http = response as? HTTPURLResponse else { return }\n    print(http.statusCode)\n    print(String(data: data, encoding: .utf8) ?? "")\n}\ntask.resume()\n`;
    }
    case 'rust:reqwest': {
      return `#[tokio::main]\nasync fn main() -> Result<(), reqwest::Error> {\n    let client = reqwest::Client::new();\n    let response = client\n        .request(reqwest::Method::from_bytes(b"${p.method}").unwrap(), ${q.str(p.url)})\n${headers.map((h) => `        .header(${q.str(h.key)}, ${q.str(h.value)})\n`).join('')}${p.bodyText && !p.bodyIsBinary ? `        .body(${q.str(p.bodyText)})\n` : ''}        .send()\n        .await?;\n    println!("{}", response.status());\n    println!("{}", response.text().await?);\n    Ok(())\n}\n`;
    }
    case 'scala:sttp': {
      return `import sttp.client4.quick.*\n\nval request = basicRequest\n  .method(sttp.model.Method.${p.method.toUpperCase()}, uri"${p.url}")\n${headers.map((h) => `  .header(${q.str(h.key)}, ${q.str(h.value)})\n`).join('')}${p.bodyText && !p.bodyIsBinary ? `  .body(${q.str(p.bodyText)})\n` : ''}val response = request.send()\nprintln(response.code)\nprintln(response.body)\n`;
    }
    case 'r:httr': {
      return `library(httr)\n\nresponse <- VERB(${q.str(p.method)}, url = ${q.str(p.url)}${headers.length ? `,\n  add_headers(\n${headers.map((h) => `    \`${h.key}\` = ${q.str(h.value)}`).join(',\n')}\n  )` : ''}${p.bodyText && !p.bodyIsBinary ? `,\n  body = ${q.str(p.bodyText)}` : ''})\n\ncat(status_code(response), "\\n")\ncat(content(response, "text", encoding = "UTF-8"))\n`;
    }
    case 'elixir:req': {
      return `response = Req.request!(\n  method: :${p.method.toLowerCase()},\n  url: ${q.str(p.url)}${headers.length ? `,\n  headers: [\n${headers.map((h) => `    {${q.str(h.key)}, ${q.str(h.value)}}`).join(',\n')}\n  ]` : ''}${p.bodyText && !p.bodyIsBinary ? `,\n  body: ${q.str(p.bodyText)}` : ''}\n)\n\nIO.puts(response.status)\nIO.puts(response.body)\n`;
    }
    case 'objc:nsurlsession': {
      return `#import <Foundation/Foundation.h>\n\nNSURL *url = [NSURL URLWithString:@${q.str(p.url)}];\nNSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];\nrequest.HTTPMethod = @${q.str(p.method)};\n${headers.map((h) => `[request setValue:@${q.str(h.value)} forHTTPHeaderField:@${q.str(h.key)}];\n`).join('')}${p.bodyText && !p.bodyIsBinary ? `request.HTTPBody = [@${q.str(p.bodyText)} dataUsingEncoding:NSUTF8StringEncoding];\n` : ''}\n[[[NSURLSession sharedSession] dataTaskWithRequest:request\n    completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {\n        NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;\n        NSLog(@"%ld", (long)http.statusCode);\n        NSLog(@"%@", [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]);\n    }] resume];\n[[NSRunLoop mainRunLoop] run];\n`;
    }
    default:
      return `// Code generation for ${language}/${v} is not available.`;
  }
}

function pascal(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }
function sanitize(s: string): string { return s.replace(/[^A-Za-z0-9]/g, '_'); }

class URLsafe {
  url: URL;
  constructor(u: string) { this.url = new URL(u.includes('://') ? u : `http://${u}`); }
  get hostname(): string { return this.url.hostname; }
  get port(): string { return this.url.port; }
  get path(): string { return `${this.url.pathname}${this.url.search}`; }
  get base(): string { return `${this.url.protocol}//${this.url.host}`; }
  get isHttps(): boolean { return this.url.protocol === 'https:'; }
}
