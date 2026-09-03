# Security

Security is a product feature (Product Master Direction §18). This lists what is enforced today and how it is tested.

| Requirement                 | Implementation                                                                                                                                                                        | Evidence                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Tenant isolation            | RLS enabled and forced on every tenant table; runtime role `NOBYPASSRLS`; scopes set transaction-locally by the runner; tenant id never taken from a request body                     | `tests/integration/tenancy-rls.test.ts`, `tests/architecture/sql-invariants.test.ts`, readiness check |
| Least privilege             | `dolmir_app` holds `SELECT`/`INSERT` (+ `UPDATE` where legitimate) and no `DELETE`; append-only tables refuse `UPDATE`/`DELETE` for every role                                        | SQL invariants test; append-only tests on audit, ledger, usage                                        |
| Authentication              | JWT verification (`jose`), algorithms pinned per key source, issuer and audience checked, clock injected; dev tokens only outside production                                          | `jwt-verifier.test.ts`, e2e 401 contract                                                              |
| Authorisation               | Deterministic `Authorizer` over a versioned role matrix; every route and tool names its permission; AI actors can never hold `decisions:approve`                                      | `authorizer.test.ts`, `executor.test.ts`, e2e role-based denial                                       |
| Controlled AI tools         | Typed tools with effect and permission; action policy levels; input and output validation; audit on every outcome                                                                     | `executor.test.ts`                                                                                    |
| Approval gates              | `act` tools require a matching approval; nothing auto-executes by default                                                                                                             | `executor.test.ts`                                                                                    |
| Secrets                     | `process.env` read in one file; `Secret` wrapper cannot be printed; pino redacts credential paths; `.env*` git-ignored; gitleaks in CI                                                | `load-config.test.ts`, `pino-logger.test.ts`, manual boot check (no secrets in log)                   |
| Safe logging (PII)          | Emails, phones, VAT numbers, fiscal codes and IBANs redacted in every logged string; domain records live in tables, not logs                                                          | `redaction.test.ts`, `pino-logger.test.ts`                                                            |
| Audit                       | Every provisioning, system-scope transaction and tool execution writes an audit row with actor, request and correlation ids                                                           | audit tests, e2e audit listing                                                                        |
| Prompt-injection resistance | Untrusted content travels as data in `messages`; system instructions never come from documents; structured outputs validated; tools bound what a model can cause; links never fetched | design + `anthropic-llm-provider.test.ts`                                                             |
| Error hygiene               | RFC 9457 problems; infrastructure/internal messages and details never reach clients; vendor exceptions never cross ports                                                              | `problem-details.test.ts`, e2e                                                                        |
| Request correlation         | Client `x-request-id` honoured only if a valid UUID; ids echoed in headers; security headers on every response                                                                        | e2e                                                                                                   |
| Dependency hygiene          | `pnpm audit --prod --audit-level=critical` in CI; frozen lockfile; `onlyBuiltDependencies` restricts install scripts                                                                  | CI                                                                                                    |

## Not yet (scheduled)

Rate limiting and abuse controls (Phase 2, before public exposure); encrypted per-tenant connector credentials (with the connector abstraction); persisted approvals (Phase 2e); backups, retention and data-residency choices (Phase 3); SSO and enterprise controls (Phase 6).

## Reporting

Security issues: contact the repository owner directly; do not open a public issue.
