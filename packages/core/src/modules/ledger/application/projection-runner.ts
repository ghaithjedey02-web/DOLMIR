import type { SystemScope, TransactionRunner } from '../../../kernel/scope.js';
import type { LedgerEvent } from '../domain/ledger-event.js';
import type { LedgerRepository, ProjectionCheckpointRepository } from './ports.js';

/**
 * A read model derived from the ledger. `apply` is called once per event in
 * global order, inside a system-scope transaction shared with the checkpoint
 * update, so a projection is never ahead of or behind its checkpoint.
 * `reset` clears the read model so it can be rebuilt from the first event.
 */
export interface Projection {
  readonly name: string;
  apply(scope: SystemScope, event: LedgerEvent): Promise<void>;
  reset(scope: SystemScope): Promise<void>;
}

export interface ProjectionRunnerDependencies {
  readonly transactions: TransactionRunner;
  readonly ledger: LedgerRepository;
  readonly checkpoints: ProjectionCheckpointRepository;
  readonly batchSize?: number;
}

export interface ProjectionRunReport {
  readonly processed: number;
  readonly lastGlobalSequence: number;
}

export class ProjectionRunner {
  private readonly deps: ProjectionRunnerDependencies;
  private readonly batchSize: number;

  constructor(deps: ProjectionRunnerDependencies) {
    this.deps = deps;
    this.batchSize = deps.batchSize ?? 200;
  }

  /** Applies every event the projection has not seen yet. Idempotent when nothing is new. */
  async runOnce(projection: Projection): Promise<ProjectionRunReport> {
    let processed = 0;
    let last = 0;
    for (;;) {
      const batch = await this.deps.transactions.withSystemScope(
        `projection:${projection.name}`,
        async (scope) => {
          const checkpoint = await this.deps.checkpoints.get(scope, projection.name);
          const events = await this.deps.ledger.readAll(scope, checkpoint, this.batchSize);
          for (const event of events) {
            await projection.apply(scope, event);
          }
          const lastInBatch = events.at(-1)?.globalSequence ?? checkpoint;
          if (events.length > 0) {
            await this.deps.checkpoints.set(scope, projection.name, lastInBatch);
          }
          return { count: events.length, last: lastInBatch };
        },
      );
      processed += batch.count;
      last = batch.last;
      if (batch.count < this.batchSize) break;
    }
    return { processed, lastGlobalSequence: last };
  }

  /** Drops the read model and replays the whole ledger into it. */
  async rebuild(projection: Projection): Promise<ProjectionRunReport> {
    await this.deps.transactions.withSystemScope(
      `projection_rebuild:${projection.name}`,
      async (scope) => {
        await projection.reset(scope);
        await this.deps.checkpoints.set(scope, projection.name, 0);
      },
    );
    return this.runOnce(projection);
  }
}
