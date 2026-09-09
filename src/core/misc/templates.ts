/**
 * Collection templates (§31). Reusable starting points for common API shapes.
 */
import type { ApiRequest } from '../../shared/types';
import { uid } from '../../shared/ids';
import { kv } from '../url/urlBuilder';
import { freshCollection, freshFolder, freshRequest } from '../importers/model';

export interface CollectionTemplate {
  id: string;
  label: string;
  description: string;
  build: (workspaceId: string, name: string) => {
    collection: ReturnType<typeof freshCollection>;
    folders: ReturnType<typeof freshFolder>[];
    requests: ApiRequest[];
  };
}

function req(workspaceId: string, collectionId: string, name: string, method: string, url: string, body?: Partial<ApiRequest['body']>, headers: [string, string][] = [], folderId?: string): ApiRequest {
  const r = freshRequest(workspaceId, name, collectionId, folderId);
  r.method = method;
  r.url = url;
  r.headers = headers.map(([k, v]) => kv(k, v));
  if (body) r.body = { type: 'none', ...body } as ApiRequest['body'];
  return r;
}

export const COLLECTION_TEMPLATES: CollectionTemplate[] = [
  {
    id: 'rest-crud',
    label: 'REST CRUD API',
    description: 'Standard create/read/update/delete flow with variables and tests.',
    build(workspaceId, name) {
      const collection = freshCollection(workspaceId, name);
      collection.variables = [{ id: uid(), key: 'baseUrl', value: 'https://api.example.com', type: 'default', enabled: true }, { id: uid(), key: 'resourceId', value: '', type: 'default', enabled: true }];
      const list = req(workspaceId, collection.id, 'List items', 'GET', '{{baseUrl}}/items');
      list.scripts.postResponse = `pm.test('status is 200', () => pm.response.to.have.status(200));`;
      const create = req(workspaceId, collection.id, 'Create item', 'POST', '{{baseUrl}}/items', { type: 'json', raw: '{\n  "name": "{{$randomFullName}}"\n}' }, [['Content-Type', 'application/json']]);
      create.scripts.postResponse = `pm.test('created', () => pm.expect(pm.response.code).to.be.within(200, 299));\nconst body = pm.response.json();\nif (body && body.id) pm.collectionVariables.set('resourceId', String(body.id));`;
      const getOne = req(workspaceId, collection.id, 'Get item', 'GET', '{{baseUrl}}/items/{{resourceId}}');
      const update = req(workspaceId, collection.id, 'Update item', 'PUT', '{{baseUrl}}/items/{{resourceId}}', { type: 'json', raw: '{\n  "name": "Updated {{$randomFullName}}"\n}' }, [['Content-Type', 'application/json']]);
      const remove = req(workspaceId, collection.id, 'Delete item', 'DELETE', '{{baseUrl}}/items/{{resourceId}}');
      remove.scripts.postResponse = `pm.test('deleted', () => pm.expect(pm.response.code).to.be.within(200, 299));`;
      for (const r of [create, getOne, update, remove]) r.auth = { type: 'inherit' };
      collection.auth = { type: 'bearer', bearer: { token: '{{token}}' } };
      collection.variables.push({ id: uid(), key: 'token', value: '', type: 'secret', enabled: true });
      return { collection, folders: [], requests: [list, create, getOne, update, remove] };
    },
  },
  {
    id: 'oauth2-api',
    label: 'OAuth 2.0 API',
    description: 'Token acquisition + authenticated resource calls.',
    build(workspaceId, name) {
      const collection = freshCollection(workspaceId, name);
      collection.variables = [
        { id: uid(), key: 'authBaseUrl', value: 'https://auth.example.com', type: 'default', enabled: true },
        { id: uid(), key: 'baseUrl', value: 'https://api.example.com', type: 'default', enabled: true },
        { id: uid(), key: 'clientId', value: '', type: 'default', enabled: true },
        { id: uid(), key: 'clientSecret', value: '', type: 'secret', enabled: true },
      ];
      const token = req(workspaceId, collection.id, 'Get token (client credentials)', 'POST', '{{authBaseUrl}}/oauth/token', {
        type: 'urlencoded',
        urlencoded: [kv('grant_type', 'client_credentials'), kv('client_id', '{{clientId}}'), kv('client_secret', '{{clientSecret}}'), kv('scope', 'read')],
      }, [['Content-Type', 'application/x-www-form-urlencoded']]);
      token.scripts.postResponse = `const body = pm.response.json();\nif (body && body.access_token) {\n  pm.collectionVariables.set('accessToken', body.access_token);\n  pm.test('token acquired', () => pm.expect(body.access_token).to.exist);\n}`;
      const me = req(workspaceId, collection.id, 'Authenticated call', 'GET', '{{baseUrl}}/me');
      me.auth = { type: 'bearer', bearer: { token: '{{accessToken}}' } };
      collection.variables.push({ id: uid(), key: 'accessToken', value: '', type: 'secret', enabled: true });
      return { collection, folders: [], requests: [token, me] };
    },
  },
  {
    id: 'graphql-api',
    label: 'GraphQL API',
    description: 'Query, mutation and introspection requests.',
    build(workspaceId, name) {
      const collection = freshCollection(workspaceId, name);
      collection.variables = [{ id: uid(), key: 'graphqlUrl', value: 'https://api.example.com/graphql', type: 'default', enabled: true }];
      const query = req(workspaceId, collection.id, 'Query', 'POST', '{{graphqlUrl}}');
      query.protocol = 'graphql';
      query.body = { type: 'graphql', graphql: { query: 'query GetUser($id: ID!) {\n  user(id: $id) {\n    id\n    name\n    email\n  }\n}', variables: '{\n  "id": "1"\n}' } };
      const mutation = req(workspaceId, collection.id, 'Mutation', 'POST', '{{graphqlUrl}}');
      mutation.protocol = 'graphql';
      mutation.body = { type: 'graphql', graphql: { query: 'mutation CreateUser($input: CreateUserInput!) {\n  createUser(input: $input) {\n    id\n    name\n  }\n}', variables: '{\n  "input": { "name": "Ada" }\n}' } };
      const introspect = req(workspaceId, collection.id, 'Introspection', 'POST', '{{graphqlUrl}}');
      introspect.protocol = 'graphql';
      introspect.body = { type: 'graphql', graphql: { query: '{ __schema { queryType { name } mutationType { name } } }', variables: '' } };
      return { collection, folders: [], requests: [query, mutation, introspect] };
    },
  },
  {
    id: 'soap-service',
    label: 'SOAP Service',
    description: 'SOAP 1.1 request structure with SOAPAction and fault assertion.',
    build(workspaceId, name) {
      const collection = freshCollection(workspaceId, name);
      collection.variables = [{ id: uid(), key: 'endpoint', value: 'https://example.com/soap', type: 'default', enabled: true }];
      const call = req(workspaceId, collection.id, 'SOAP call', 'POST', '{{endpoint}}');
      call.protocol = 'soap';
      call.protocolData = { soap: { version: '1.1', action: 'ExampleAction' } };
      call.headers = [kv('Content-Type', 'text/xml; charset=utf-8'), kv('SOAPAction', 'ExampleAction')];
      call.body = { type: 'xml', raw: '<ser:ExampleRequest>\n  <ser:Param>string</ser:Param>\n</ser:ExampleRequest>' };
      call.assertions = [{ id: uid(), type: 'soapFault', enabled: true, name: 'No SOAP Fault' }];
      return { collection, folders: [], requests: [call] };
    },
  },
  {
    id: 'websocket-api',
    label: 'WebSocket API',
    description: 'WebSocket connection with message templates.',
    build(workspaceId, name) {
      const collection = freshCollection(workspaceId, name);
      collection.variables = [{ id: uid(), key: 'wsUrl', value: 'wss://echo.websocket.org', type: 'default', enabled: true }];
      const ws = req(workspaceId, collection.id, 'WebSocket connection', 'GET', '{{wsUrl}}');
      ws.protocol = 'websocket';
      ws.protocolData = { websocket: {} };
      return { collection, folders: [], requests: [ws] };
    },
  },
  {
    id: 'grpc-service',
    label: 'gRPC Service',
    description: 'gRPC with proto file and reflection toggle.',
    build(workspaceId, name) {
      const collection = freshCollection(workspaceId, name);
      collection.variables = [{ id: uid(), key: 'grpcHost', value: 'grpc.example.com:443', type: 'default', enabled: true }];
      const call = req(workspaceId, collection.id, 'gRPC call', 'POST', '{{grpcHost}}');
      call.protocol = 'grpc';
      call.protocolData = { grpc: { protoFiles: [], useReflection: true, useTls: true, metadata: [], service: '', method: '' } };
      return { collection, folders: [], requests: [call] };
    },
  },
  {
    id: 'mqtt-broker',
    label: 'MQTT',
    description: 'MQTT publish/subscribe templates.',
    build(workspaceId, name) {
      const collection = freshCollection(workspaceId, name);
      const call = req(workspaceId, collection.id, 'MQTT publish', 'POST', 'mqtt://broker:1883');
      call.protocol = 'mqtt';
      call.protocolData = { mqtt: { host: 'broker', port: 1883, useTls: false, topic: 'topic/test', qos: 0 } };
      return { collection, folders: [], requests: [call] };
    },
  },
  {
    id: 'webhook-test',
    label: 'Webhook receiver',
    description: 'Start a local webhook receiver and fire test requests.',
    build(workspaceId, name) {
      const collection = freshCollection(workspaceId, name);
      const fire = req(workspaceId, collection.id, 'Fire webhook', 'POST', 'http://localhost:{{webhookPort}}{{webhookPath}}', { type: 'json', raw: '{\n  "event": "test",\n  "ts": "{{$isoTimestamp}}"\n}' }, [['Content-Type', 'application/json']]);
      collection.variables = [
        { id: uid(), key: 'webhookPort', value: '4937', type: 'default', enabled: true },
        { id: uid(), key: 'webhookPath', value: '/hook', type: 'default', enabled: true },
      ];
      return { collection, folders: [], requests: [fire] };
    },
  },
  {
    id: 'api-test-suite',
    label: 'API Test Suite',
    description: 'Assertion-rich requests ready for the Collection Runner.',
    build(workspaceId, name) {
      const collection = freshCollection(workspaceId, name);
      collection.variables = [{ id: uid(), key: 'baseUrl', value: 'https://api.example.com', type: 'default', enabled: true }];
      const health = req(workspaceId, collection.id, 'Health check', 'GET', '{{baseUrl}}/health');
      health.assertions = [
        { id: uid(), type: 'statusCode', enabled: true, name: 'Status 200', operator: 'eq', expected: '200' },
        { id: uid(), type: 'responseTime', enabled: true, name: 'Under 500ms', operator: 'lte', expected: '500' },
      ];
      const contract = req(workspaceId, collection.id, 'Contract check', 'GET', '{{baseUrl}}/items/1');
      contract.assertions = [
        { id: uid(), type: 'statusCode', enabled: true, name: 'Status 200', operator: 'eq', expected: '200' },
        { id: uid(), type: 'contentType', enabled: true, name: 'JSON content', operator: 'contains', expected: 'json' },
        { id: uid(), type: 'jsonProperty', enabled: true, name: 'Has id', property: 'id', operator: 'exists' },
      ];
      return { collection, folders: [], requests: [health, contract] };
    },
  },
];

export function getTemplate(id: string): CollectionTemplate | undefined {
  return COLLECTION_TEMPLATES.find((t) => t.id === id);
}
