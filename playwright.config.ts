import { defineConfig } from '@playwright/test';

/**
 * E2E tests drive the standalone hub + renderer build.
 * Browser download requires network access to the Playwright CDN; in
 * restricted CI environments set API_MANAGER_E2E=0 to skip.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  retries: 0,
  use: {
    baseURL: process.env.API_MANAGER_BASE_URL || 'http://127.0.0.1:4520',
    headless: true,
  },
  webServer: {
    command: 'npm run hub -- --port 4520 --data-dir .e2e-data --serve-renderer',
    url: 'http://127.0.0.1:4520/api/health',
    reuseExistingServer: true,
    timeout: 30000,
  },
});
