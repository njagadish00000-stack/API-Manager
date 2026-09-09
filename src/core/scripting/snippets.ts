/** Built-in script snippet library (§33). Pre-request & test snippets. */

export interface Snippet { id: string; category: 'pre-request' | 'test' | 'utility'; name: string; code: string; description?: string }

export const SNIPPETS: Snippet[] = [
  { id: 'status-200', category: 'test', name: 'Status code is 200', code: `pm.test('Status code is 200', () => {\n  pm.response.to.have.status(200);\n});` },
  { id: 'status-created', category: 'test', name: 'Status code is 201', code: `pm.test('Status code is 201', () => {\n  pm.response.to.have.status(201);\n});` },
  { id: 'json-value', category: 'test', name: 'JSON value check', code: `pm.test('Response has expected value', () => {\n  const body = pm.response.json();\n  pm.expect(body.key).to.eql('value');\n});` },
  { id: 'response-time', category: 'test', name: 'Response time below 500ms', code: `pm.test('Response time is acceptable', () => {\n  pm.expect(pm.response.responseTime).to.be.below(500);\n});` },
  { id: 'header-exists', category: 'test', name: 'Header exists', code: `pm.test('Content-Type header is present', () => {\n  pm.response.to.have.header('Content-Type');\n});` },
  { id: 'content-type-json', category: 'test', name: 'Content-Type is JSON', code: `pm.test('Response is JSON', () => {\n  pm.expect(pm.response.headers.get('Content-Type') ?? '').to.include('application/json');\n});` },
  { id: 'array-not-empty', category: 'test', name: 'JSON array is not empty', code: `pm.test('Array is not empty', () => {\n  const body = pm.response.json();\n  pm.expect(body).to.be.an('array');\n  pm.expect(body.length).to.be.above(0);\n});` },
  { id: 'schema-validation', category: 'test', name: 'Validate against schema', code: `const schema = {\n  type: 'object',\n  properties: {\n    id: { type: ['string', 'number'] },\n    name: { type: 'string' }\n  },\n  required: ['id', 'name']\n};\npm.test('Schema is valid', () => {\n  const body = pm.response.json();\n  pm.expect(body).to.have.property('id');\n  pm.expect(body).to.have.property('name');\n});` },
  { id: 'set-env-from-response', category: 'test', name: 'Save value to environment', code: `const body = pm.response.json();\nif (body && body.token) {\n  pm.environment.set('token', body.token);\n}` },
  { id: 'get-timestamp', category: 'pre-request', name: 'Set timestamp variable', code: `pm.variables.set('timestamp', Math.floor(Date.now() / 1000));` },
  { id: 'random-uuid', category: 'pre-request', name: 'Set UUID variable', code: `pm.variables.set('requestId', '{{$uuid}}');` },
  { id: 'bearer-from-env', category: 'pre-request', name: 'Use bearer token from environment', code: `// Auth tab → Bearer → token: {{token}}\n// This snippet just validates it exists:\nif (!pm.environment.get('token')) {\n  console.warn('No token in environment — login request should run first');\n}` },
  { id: 'send-request', category: 'utility', name: 'Send additional request', code: `pm.sendRequest('https://api.example.com/ping', (err, res) => {\n  if (err) { console.error(err); return; }\n  console.log('Ping status:', res.code);\n});` },
  { id: 'set-next-request', category: 'utility', name: 'Set next request (runner)', code: `// Inside a collection run: jump to a specific request next\npm.execution.setNextRequest('Request Name');\n// Use null to stop the run:\n// pm.execution.setNextRequest(null);` },
  { id: 'skip-request', category: 'utility', name: 'Skip current request (pre-request)', code: `if (!pm.environment.get('token')) {\n  pm.execution.skipRequest();\n}` },
  { id: 'cookies-check', category: 'test', name: 'Cookie is set', code: `pm.test('Session cookie is set', () => {\n  pm.expect(pm.cookies.has('session')).to.be.true;\n});` },
  { id: 'xml-xpath', category: 'test', name: 'SOAP/XML XPath check', code: `// Use the declarative XPath assertion in the Tests tab,\n// or do it in script:\npm.test('Response has no fault', () => {\n  pm.expect(pm.response.text()).to.not.include('Fault');\n});` },
  { id: 'iterate-array', category: 'test', name: 'Verify all array items', code: `pm.test('All items have an id', () => {\n  const body = pm.response.json();\n  body.forEach((item) => pm.expect(item.id).to.exist);\n});` },
  { id: 'hmac-signature', category: 'pre-request', name: 'HMAC signature header', code: `// Note: crypto helpers are available via dynamic variables instead;\n// see the docs → "Signatures" for the recommended pattern with utilities.` },
];

export const SCRIPT_TEMPLATES: { id: string; name: string; code: string }[] = [
  { id: 'empty', name: 'Empty', code: '' },
  { id: 'basic-tests', name: 'Basic test suite', code: `pm.test('Status is 2xx', () => {\n  pm.expect(pm.response.code).to.be.within(200, 299);\n});\n\npm.test('Response time < 1s', () => {\n  pm.expect(pm.response.responseTime).to.be.below(1000);\n});\n` },
  { id: 'login-flow', name: 'Login flow (save token)', code: `// Post-response script for a login request\nconst body = pm.response.json();\nif (body && body.access_token) {\n  pm.environment.set('token', body.access_token);\n  pm.test('Token saved', () => pm.expect(body.access_token).to.exist);\n} else {\n  pm.test('Token present', () => pm.expect(body.access_token).to.exist);\n}\n` },
  { id: 'pagination', name: 'Pagination walker', code: `// Runs the same request again with ?page=N+1 until no results\nconst body = pm.response.json();\nconst page = Number(pm.variables.get('page') ?? 1);\nif (body && Array.isArray(body.items) && body.items.length > 0) {\n  pm.variables.set('page', String(page + 1));\n  pm.execution.setNextRequest(pm.info.requestName);\n} else {\n  pm.variables.set('page', '1');\n  pm.execution.setNextRequest(null);\n}\n` },
];
