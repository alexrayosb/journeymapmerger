import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

/**
 * End-to-end tests. Default target is a local `vite preview` of the built
 * site (closest to production). Set E2E_BASE_URL to run the same suite
 * against the live site instead.
 */
const baseURL = process.env['E2E_BASE_URL'];
const isCI = Boolean(process.env['CI']);

const reporter: PlaywrightTestConfig['reporter'] = isCI
  ? [['list'], ['html', { open: 'never' }]]
  : 'list';

const webServer: PlaywrightTestConfig['webServer'] = {
  command: 'npm run build && npm run preview -- --port 4173 --strictPort',
  url: 'http://localhost:4173',
  reuseExistingServer: !isCI,
  timeout: 120_000,
};

export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: isCI ? 1 : 0,
  reporter,
  use: {
    baseURL: baseURL ?? 'http://localhost:4173',
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
  // Against the live site (E2E_BASE_URL set) nothing needs starting.
  ...(baseURL === undefined ? { webServer } : {}),
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
