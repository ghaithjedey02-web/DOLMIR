import {
  type JobDefinition,
  analyzeDocumentJob,
  executeRecommendationJob,
  mailboxPollJob,
  recoverExecutionsJob,
} from '@dolmir/core';

/**
 * The background jobs this deployment runs.
 *
 * One list, two readers, and that is the point. `createContainer` registers a
 * handler for each of these when the runtime starts; `dolmir jobs:install`
 * creates a queue for each of them at deploy time. A job that appears in one
 * place and not the other is a job that either has no queue to be worked from
 * or no worker to carry it out — the second is what left DOLMIR unable to
 * execute approved work in production. `container.test.ts` asserts that what
 * the container actually registers is exactly this list.
 *
 * Membership here does not mean a job runs on a schedule. Only
 * `cases.recover_executions` has one; `mailbox.poll` has a handler and no
 * schedule, so a poll happens when something explicitly asks for one and never
 * on its own (ADR-0013 — DOLMIR does not yet consume a real mailbox unattended).
 */
export type InstallableJob = Pick<
  JobDefinition<object>,
  'name' | 'retryLimit' | 'retryDelaySeconds' | 'expireInSeconds' | 'concurrency'
>;

export const PLATFORM_JOBS: readonly InstallableJob[] = Object.freeze([
  analyzeDocumentJob,
  mailboxPollJob,
  executeRecommendationJob,
  recoverExecutionsJob,
]);
