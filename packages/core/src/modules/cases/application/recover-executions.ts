import type { OrganizationId } from '../../../kernel/ids.js';
import { type Logger, noopLogger } from '../../../kernel/logger.js';
import type { TransactionRunner } from '../../../kernel/scope.js';
import type { Telemetry } from '../../../kernel/telemetry.js';
import type { ActionIntentRepository, ExecutionScheduler } from './ports.js';

/**
 * RECOVER. Approving a recommendation commits the entitlement to carry it out
 * and then asks a worker to do so — two steps, and only the first is
 * transactional. A queue that is down for a minute, a lost acknowledgement, a
 * process that dies between the commit and the enqueue: any of them leaves
 * work that was authorised and that nobody is going to do.
 *
 * This sweep is the answer, and it is deliberately dull. It looks for
 * entitlements that have not reached a conclusion and asks for them again,
 * under the same queue key the approval used. It creates nothing, decides
 * nothing and sends nothing: everything it finds goes through the ordinary
 * worker, which locks the entitlement and refuses to repeat what is already
 * done. Running it twice is therefore the same as running it once, and running
 * it against work that is already finished is the same as not running it.
 *
 * Tenancy is the reason it is two steps rather than one. Finding work across
 * tenants needs a system scope, so that scope is given the narrowest possible
 * question — *which* tenants have unfinished work — and never sees an
 * entitlement. Each tenant's rows are then read inside that tenant's own
 * scope, under row-level security, exactly as any other reader would.
 */
export interface RecoverExecutionsDependencies {
  readonly transactions: TransactionRunner;
  readonly intents: ActionIntentRepository;
  readonly scheduler: ExecutionScheduler;
  readonly logger?: Logger;
  readonly telemetry?: Telemetry;
  /** Tenants examined per sweep. The next sweep continues where this one stopped. */
  readonly tenantLimit?: number;
  /** Entitlements re-enqueued per tenant per sweep. */
  readonly perTenantLimit?: number;
  /**
   * Committed attempts after which an entitlement stops being swept. Recovery
   * exists for work nobody picked up and for failures worth another go; it is
   * not a way to retry something broken forever. What is exhausted stays in
   * the table, `failed`, with its last error, for a person to look at.
   */
  readonly maxAttempts?: number;
}

export interface RecoveryReport {
  readonly tenants: number;
  readonly found: number;
  /** Asked for again. A queue that already holds the job counts here too. */
  readonly requeued: number;
  /** Found, but past the attempt limit: left alone rather than retried again. */
  readonly exhausted: number;
  /** Tenants whose sweep failed; their work stays unfinished and is tried next time. */
  readonly failed: number;
}

const SYSTEM_SCOPE_REASON = 'recover_unfinished_executions';

export class RecoverExecutions {
  private readonly deps: RecoverExecutionsDependencies;
  private readonly logger: Logger;
  private readonly tenantLimit: number;
  private readonly perTenantLimit: number;
  private readonly maxAttempts: number;

  constructor(deps: RecoverExecutionsDependencies) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
    this.tenantLimit = deps.tenantLimit ?? 200;
    this.perTenantLimit = deps.perTenantLimit ?? 100;
    this.maxAttempts = deps.maxAttempts ?? 10;
  }

  async execute(): Promise<RecoveryReport> {
    const tenants = await this.deps.transactions.withSystemScope(
      SYSTEM_SCOPE_REASON,
      // Identifiers only: the system scope never reads an entitlement.
      (scope) => this.deps.intents.listTenantsWithUnfinished(scope, this.tenantLimit),
    );

    let found = 0;
    let requeued = 0;
    let exhausted = 0;
    let failed = 0;
    for (const tenantId of tenants) {
      const report = await this.sweepTenant(tenantId);
      found += report.found;
      requeued += report.requeued;
      exhausted += report.exhausted;
      if (report.failed) failed += 1;
    }

    const report: RecoveryReport = { tenants: tenants.length, found, requeued, exhausted, failed };
    if (found > 0 || failed > 0) {
      this.logger.info('unfinished executions recovered', { ...report });
    }
    this.deps.telemetry?.count('cases.recovery.requeued', {}, requeued);
    return report;
  }

  /**
   * One tenant, inside its own scope. A tenant whose sweep fails is skipped
   * rather than allowed to stop the others: its entitlements are still
   * durable, and the next sweep will find them again.
   */
  private async sweepTenant(
    tenantId: OrganizationId,
  ): Promise<{ found: number; requeued: number; exhausted: number; failed: boolean }> {
    let unfinished;
    try {
      unfinished = await this.deps.transactions.withTenant(tenantId, (scope) =>
        this.deps.intents.listUnfinished(scope, this.perTenantLimit),
      );
    } catch (error) {
      this.logger.warn('could not read unfinished executions', {
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { found: 0, requeued: 0, exhausted: 0, failed: true };
    }

    let requeued = 0;
    let exhausted = 0;
    for (const intent of unfinished) {
      if (intent.attempts >= this.maxAttempts) {
        // Tried enough. Something is wrong with this one in a way another
        // attempt will not fix, so it is left for a person rather than
        // re-enqueued every few minutes for ever.
        exhausted += 1;
        continue;
      }
      try {
        // The same queue key the approval used, so a job that is already
        // waiting is not duplicated; and the worker's lock is what stops a
        // duplicate action, whatever the queue decides.
        await this.deps.scheduler.scheduleExecution(tenantId, intent.recommendationId);
        requeued += 1;
      } catch (error) {
        // The queue is unavailable. The entitlement is untouched, so nothing is
        // lost: this row is simply found again by the next sweep.
        this.logger.warn('could not re-enqueue an unfinished execution', {
          tenantId,
          recommendationId: intent.recommendationId,
          error: error instanceof Error ? error.message : String(error),
        });
        return { found: unfinished.length, requeued, exhausted, failed: true };
      }
    }
    return { found: unfinished.length, requeued, exhausted, failed: false };
  }
}
