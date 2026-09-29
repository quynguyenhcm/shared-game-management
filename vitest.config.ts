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
          include: ['**/*.test.ts'],
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
        'packages/shared/src/{money,time}/**/*.ts',
        'apps/api/src/lib/{crypto,config,notifications,jobs}/**/*.ts',
      ],
      exclude: ['**/*.test.ts', '**/*.int.test.ts'],
      // Thresholds apply to files matched by `include`; modules that do not exist yet
      // (money, time, crypto, notifications, jobs land in Phases 3-5) are not required.
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
