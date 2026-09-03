// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * Lint policy. Type-aware rules are on because an async backend without
 * `no-floating-promises` loses errors silently; the architectural bans below
 * complement dependency-cruiser (which owns module-graph rules).
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', 'supabase/**', '.dolmir/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // One lint-only project covering sources and colocated tests; the
        // build projects exclude tests, so the project service cannot see them.
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      // Zod inference produces types that ESLint's "unnecessary condition" rule
      // misreads; keep the rule but let explicit runtime guards stand.
      '@typescript-eslint/no-unnecessary-condition': [
        'error',
        { allowConstantLoopConditions: true },
      ],
      // An async method with no await is the normal way an in-memory adapter
      // implements an asynchronous port; the rule's signal is lost here.
      '@typescript-eslint/require-await': 'off',
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      // Secrets and configuration enter through the validated loader only
      // (Directive §18; ADR-0003). The allowed location is re-enabled below.
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            'Read configuration through the validated config loader, never process.env directly.',
        },
      ],
      // Vendor SDKs live in adapters only (ADR-0006). dependency-cruiser
      // enforces the same rule at the module-graph level.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@anthropic-ai/sdk',
              message: 'Only packages/core/src/ai/adapters/anthropic may import the vendor SDK.',
            },
          ],
          patterns: [
            {
              group: ['@anthropic-ai/sdk/*'],
              message: 'Only packages/core/src/ai/adapters/anthropic may import the vendor SDK.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/core/src/ai/adapters/anthropic/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['packages/core/src/infrastructure/config/**/*.ts', 'apps/api/src/composition/env.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['**/*.test.ts', 'tests/**/*.ts', 'vitest.config.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },
  prettier,
);
