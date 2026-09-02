/**
 * DOLMIR architecture rules — enforced, not suggested (ADR-0003, ADR-0006).
 *
 * A violation here is a failing build. The module graph these rules encode:
 *
 *   kernel                       ← imports nothing else from core
 *   modules/<m>/domain           ← kernel, own domain
 *   modules/<m>/application      ← kernel, own domain, own application (ports), other modules' index
 *   modules/<m>/adapters         ← kernel, own module, infrastructure, other modules' index
 *   modules: tenancy ← identity ← access ; audit and ledger are leaves usable by all
 *   ai                           ← kernel, access/index, audit/index (adapters may use infrastructure)
 *   infrastructure               ← kernel only
 *   apps/api                     ← packages/core (public entry) only; nothing imports apps
 *   vendor SDKs                  ← only inside the adapter that wraps them
 */

const CORE = 'packages/core/src';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'A cyclic import is a build failure, never a code-review suggestion.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'kernel-is-self-contained',
      severity: 'error',
      comment: 'The kernel is the shared substrate; it imports nothing from the rest of core.',
      from: { path: `^${CORE}/kernel/` },
      to: { path: `^${CORE}/(modules|ai|infrastructure)/` },
    },
    {
      name: 'domain-depends-only-on-kernel-and-own-domain',
      severity: 'error',
      from: { path: `^${CORE}/modules/([^/]+)/domain/` },
      to: {
        path: `^${CORE}/`,
        pathNot: [`^${CORE}/kernel/`, `^${CORE}/modules/$1/domain/`],
      },
    },
    {
      name: 'application-never-imports-adapters-or-infrastructure',
      severity: 'error',
      comment: 'Use cases depend on ports, never on concrete adapters.',
      from: { path: `^${CORE}/modules/[^/]+/application/` },
      to: { path: [`^${CORE}/modules/[^/]+/adapters/`, `^${CORE}/infrastructure/`] },
    },
    {
      name: 'modules-use-other-modules-through-their-public-index',
      severity: 'error',
      from: { path: `^${CORE}/modules/([^/]+)/` },
      to: {
        path: `^${CORE}/modules/(?!$1/)[^/]+/(domain|application|adapters)/`,
      },
    },
    {
      name: 'module-graph-tenancy',
      severity: 'error',
      comment: 'tenancy is a root module: it never depends on identity, access or ai.',
      from: { path: `^${CORE}/modules/tenancy/` },
      to: { path: [`^${CORE}/modules/(identity|access)/`, `^${CORE}/ai/`] },
    },
    {
      name: 'module-graph-identity',
      severity: 'error',
      from: { path: `^${CORE}/modules/identity/` },
      to: { path: [`^${CORE}/modules/access/`, `^${CORE}/ai/`] },
    },
    {
      name: 'module-graph-access',
      severity: 'error',
      from: { path: `^${CORE}/modules/access/` },
      to: { path: `^${CORE}/ai/` },
    },
    {
      name: 'module-graph-audit-and-ledger-are-leaves',
      severity: 'error',
      comment: 'audit and ledger depend on the kernel only, so every module can use them.',
      from: { path: `^${CORE}/modules/(audit|ledger)/` },
      to: { path: [`^${CORE}/modules/(?!(audit|ledger)/)`, `^${CORE}/ai/`] },
    },
    {
      name: 'ai-layer-dependencies',
      severity: 'error',
      comment:
        'The AI layer may use the kernel, access (permissions) and audit; nothing else in modules.',
      from: { path: `^${CORE}/ai/` },
      to: { path: `^${CORE}/modules/(?!(access|audit)/index\\.ts$)` },
    },
    {
      name: 'ai-non-adapters-never-import-infrastructure',
      severity: 'error',
      from: { path: `^${CORE}/ai/`, pathNot: `^${CORE}/ai/adapters/` },
      to: { path: `^${CORE}/infrastructure/` },
    },
    {
      name: 'infrastructure-depends-on-kernel-only',
      severity: 'error',
      from: { path: `^${CORE}/infrastructure/` },
      to: { path: `^${CORE}/(modules|ai)/` },
    },
    {
      name: 'nothing-imports-apps',
      severity: 'error',
      from: { path: '^(packages|tests)/' },
      to: { path: '^apps/' },
    },
    {
      name: 'apps-use-core-public-entry-only',
      severity: 'error',
      comment: 'Delivery code depends on the published surface of core, never on its internals.',
      from: { path: '^apps/' },
      to: { path: `^${CORE}/`, pathNot: `^${CORE}/index\\.ts$` },
    },
    {
      name: 'anthropic-sdk-only-in-its-adapter',
      severity: 'error',
      from: { pathNot: `^${CORE}/ai/adapters/anthropic/` },
      to: { path: 'node_modules/@anthropic-ai/' },
    },
    {
      name: 'pg-only-in-postgres-adapters',
      severity: 'error',
      from: {
        pathNot: [
          `^${CORE}/infrastructure/postgres/`,
          `^${CORE}/modules/[^/]+/adapters/`,
          `^${CORE}/ai/adapters/`,
          '^tests/',
        ],
      },
      to: { path: 'node_modules/(pg|pg-[^/]+)/' },
    },
    {
      name: 'jose-only-in-identity-adapters',
      severity: 'error',
      from: { pathNot: [`^${CORE}/modules/identity/adapters/`, '^tests/', '^apps/api/src/cli/'] },
      to: { path: 'node_modules/jose/' },
    },
    {
      name: 'pino-only-in-logging-infrastructure',
      severity: 'error',
      from: { pathNot: [`^${CORE}/infrastructure/logging/`, '^tests/'] },
      to: { path: 'node_modules/pino' },
    },
    {
      name: 'fastify-only-in-delivery',
      severity: 'error',
      from: { pathNot: ['^apps/api/', '^tests/'] },
      to: { path: 'node_modules/(fastify|@fastify)/' },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: { orphan: true, pathNot: ['\\.d\\.ts$', '\\.test\\.ts$', 'vitest\\.config\\.ts$'] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.tests.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['development', 'import', 'types', 'default'],
      mainFields: ['module', 'main', 'types'],
      extensions: ['.ts', '.js', '.cjs', '.mjs', '.json'],
    },
    exclude: { path: ['node_modules', '/dist/', 'coverage'] },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
