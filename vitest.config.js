import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test', STORAGE_DIR: './storage-test', APP_URL: 'http://localhost:4000' },
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    include: ['tests/**/*.test.js'],
  },
});
