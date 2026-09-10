/**
 * Single source of truth for application identity metadata.
 * Used by the hub (app.info), Electron main, CLI, renderer About page,
 * installers and documentation. Change branding/developer details HERE.
 */
export const APP_META = {
  name: 'API Manager',
  productName: 'API Manager',
  version: '1.0.0',
  developer: 'Manish Kumar Singh',
  author: 'Manish Kumar Singh',
  email: 'manishkumars264@gmail.com',
  description: 'Offline-first Postman-class desktop API development and testing application',
  appId: 'com.apimanager.offline',
  license: 'MIT',
  website: 'local-only (no telemetry, no cloud)',
} as const;

export const OFFLINE_PLEDGE = [
  'No account or login',
  'No cloud synchronization',
  'No telemetry, analytics or tracking',
  'No remote backend — all data stays on this computer',
] as const;
