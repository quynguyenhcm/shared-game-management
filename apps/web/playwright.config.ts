import { defineConfig } from '@playwright/test';

// Runs against an already-running stack: `docker compose up -d --wait`, then `pnpm run test:e2e`.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: process.env.WEB_BASE_URL ?? 'http://localhost:3000' },
});
