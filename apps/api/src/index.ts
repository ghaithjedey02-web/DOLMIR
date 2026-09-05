/**
 * The delivery layer's public surface, used by end-to-end tests and by the
 * process entry points (`main.ts`, `cli/main.ts`).
 */
export { readEnvironment } from './composition/env.js';
export { type Runtime, type StartRuntimeOptions, startRuntime } from './composition/bootstrap.js';
export { type InstallableJob, PLATFORM_JOBS } from './composition/jobs.js';
export {
  type Container,
  type ContainerOptions,
  type ReadinessReport,
  createContainer,
} from './composition/container.js';
export { type AppOptions, buildApp } from './http/app.js';
export {
  PROBLEM_TYPE_PREFIX,
  type ProblemDetails,
  problemFromDomainError,
  problemFromStatus,
  statusForCategory,
} from './http/problem-details.js';
