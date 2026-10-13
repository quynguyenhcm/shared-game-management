import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      '**/types.generated.ts',
      '.agent-logs/**',
      'memory-bank/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node, parserOptions: { projectService: false } },
  },
  {
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/cli.ts', 'apps/api/src/openapi.ts'],
    rules: { 'no-console': 'error' },
  },
  {
    // Host-TZ independence is structural (algorithm doc Q7): only UTC accessors and Intl probes.
    files: ['packages/shared/src/time/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...[
          'getFullYear',
          'getMonth',
          'getDate',
          'getDay',
          'getHours',
          'getMinutes',
          'getSeconds',
          'getMilliseconds',
          'getTimezoneOffset',
          'setFullYear',
          'setMonth',
          'setDate',
          'setHours',
          'setMinutes',
          'setSeconds',
          'setMilliseconds',
        ].map((property) => ({
          property,
          message: `Local-zone Date accessors make results depend on the host TZ; use the UTC variants or Intl.`,
        })),
        {
          object: 'Date',
          property: 'parse',
          message: 'Use parseIsoInstant (strict, offset required).',
        },
      ],
    },
  },
  {
    // Money never touches binary floating point (AC-VERIFY-14): the brand is the primary guard,
    // these rules stop the usual escape routes in the money module and money-handling code.
    files: [
      'packages/shared/src/money/**/*.ts',
      'apps/api/src/modules/**/*.ts',
      'apps/web/src/**/*.{ts,tsx}',
    ],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'parseFloat is banned for money: use parseMoney (@sgm/shared).',
        },
        {
          selector:
            "CallExpression[callee.object.name='Number'][callee.property.name='parseFloat']",
          message: 'Number.parseFloat is banned for money: use parseMoney (@sgm/shared).',
        },
        {
          selector: "CallExpression[callee.property.name='toFixed']",
          message: 'toFixed is banned for money: use toMoneyString / formatNZD (@sgm/shared).',
        },
        {
          selector:
            "CallExpression[callee.object.name='Math'][callee.property.name=/^(round|ceil|floor)$/][arguments.0.name=/(amount|fee|price|total|balance|gst|subtotal|cost|rate)/i]",
          message: 'Rounding money with Math.* is banned: use multiplyByRatio / divideByInteger.',
        },
        {
          selector:
            "CallExpression[callee.name='Number'][arguments.0.name=/(amount|fee|price|total|balance|gst|subtotal|cost|rate)/i]",
          message: 'Number(<money>) is banned: keep money as Money (bigint cents).',
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      // App Router only: there is no pages/ directory to check links against.
      '@next/next/no-html-link-for-pages': 'off',
      ...reactHooks.configs.recommended.rules,
    },
  },
  prettier,
);
