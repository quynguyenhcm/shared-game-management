import { defineConfig, devices } from '@playwright/test';

// Runs against an already-running stack: `AUTH_FAKE_OAUTH=true docker compose up -d --build --wait`
// (the fake OAuth provider is what the auth journeys use), then `pnpm run test:e2e`.
// Every spec runs twice: on a desktop viewport and on a 360 x 740 phone viewport (AC-VERIFY-12).
// One worker: the journeys share one Postgres and one Mailpit inbox, and the stack is the bottleneck.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.WEB_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 360, height: 740 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
  ],
});
