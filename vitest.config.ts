import { defineConfig } from 'vitest/config';

// Local runs pick up the developer's .env (CI provides real environment variables, which win).
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on the process environment.
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['**/*.test.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/*.int.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['**/*.int.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
          environment: 'node',
          globalSetup: ['apps/api/test/global-setup.ts'],
          pool: 'forks',
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: [
        'packages/shared/src/{money,time,invoice,auth}/**/*.ts',
        'apps/api/src/lib/{crypto,config,notifications,jobs,logger,telemetry,http}/**/*.ts',
        'apps/api/src/lib/clock.ts',
        'apps/web/src/lib/config.ts',
        // The authentication module (AC-VERIFY-9) and the web's auth/library code.
        'apps/api/src/modules/auth/**/*.ts',
        'apps/api/src/lib/auth/**/*.ts',
        // team-management (AC-VERIFY-8): the teams module.
        'apps/api/src/modules/teams/**/*.ts',
        // team-banking-and-gst (AC-VERIFY-12): the banking module and the shared NZ validators.
        'apps/api/src/modules/team-banking/**/*.ts',
        // skill-levels-and-auto-enroll (AC-VERIFY-8): the skill-levels module.
        'apps/api/src/modules/skill-levels/**/*.ts',
        'packages/shared/src/nz/**/*.ts',
        'apps/web/src/lib/**/*.ts',
      ],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/*.int.test.ts'],
      // Thresholds apply to every file matched by `include` (platform library modules and the auth code above).
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
