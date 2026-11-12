import { defineConfig } from '@playwright/test'

// End-to-end tests against the real binary (bin/ket) and PostgreSQL.
// global-setup.ts empties the database named by KET_E2E_DSN and starts the
// server on KET_E2E_PORT; the tests share it and run in order (the first
// one signs up the administrator).
const port = process.env.KET_E2E_PORT ?? '18080'

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts$/,
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    viewport: { width: 1400, height: 900 },
  },
})
