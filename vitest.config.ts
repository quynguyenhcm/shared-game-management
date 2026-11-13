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
        // session-scheduling-engine (task success criterion "at least 80% coverage"; AC-VERIFY-8 is the accessibility
        // AC): the sessions module, its recurrence and auto-enrol jobs, the allocator composition root and the shared
        // session rules.
        'apps/api/src/modules/sessions/**/*.ts',
        'apps/api/src/jobs/{recurrence-materialisation,recurrence-rule,session-auto-enrol}.ts',
        'apps/api/src/session-allocator.ts',
        'packages/shared/src/sessions/**/*.ts',
        // registration-and-waitlist (AC-VERIFY-9): the registrations module (allocator, repo, hand-off) and the shared fee rule.
        'apps/api/src/modules/registrations/**/*.ts',
        'apps/api/src/jobs/ban-reconcile.ts',
        'packages/shared/src/registrations/**/*.ts',
        'packages/shared/src/nz/**/*.ts',
        // wallet-and-akahu-billing: the billing engine, the wallet ledger, the billing jobs, the Akahu port and its fake, and the
        // shared billing rules (due date, status matrices, wallet limits).
        'apps/api/src/modules/{billing,wallet}/**/*.ts',
        'apps/api/src/jobs/{bill-session,post-game-billing,daily-overdue,akahu-jobs}.ts',
        'apps/api/src/lib/akahu/**/*.ts',
        'packages/shared/src/billing/**/*.ts',
        'packages/shared/src/api/billing.ts',
        // tax-invoices-and-exports (AC-VERIFY-7): the shared period helpers and the invoice and export contracts (the shared
        // document rules in `invoice/` are already measured), and (Phase 2) the invoices module and the two issuance jobs.
        // Phase 3 adds no new path: the document model, renderer, routes and font loader live under modules/invoices, the shared
        // document copy and long date formats under `invoice/` and `time/`, the download headers under `lib/http` and the web proxy
        // under `apps/web/src/lib`, all already measured. Phase 4 adds the income-exports module and the tabular writers (the
        // shared export columns sit under `invoice/`, already measured).
        'packages/shared/src/tax/**/*.ts',
        'packages/shared/src/api/invoices.ts',
        'apps/api/src/modules/invoices/**/*.ts',
        'apps/api/src/jobs/{issue-invoices,invoice-reconcile}.ts',
        'apps/api/src/modules/income-exports/**/*.ts',
        'apps/api/src/lib/tabular/**/*.ts',
        'apps/web/src/lib/**/*.ts',
      ],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/*.int.test.ts'],
      // Thresholds are AGGREGATE over every file matched by `include` (not per file: `perFile` is off), so one file can sit
      // below 80% while the gate passes. Keep an eye on per-file branch numbers in the report.
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
