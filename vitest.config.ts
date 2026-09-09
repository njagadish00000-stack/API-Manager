import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core'),
      '@services': resolve(__dirname, 'src/services'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    environmentMatchGlobs: [
      ['tests/ui/**', 'jsdom'],
    ],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
