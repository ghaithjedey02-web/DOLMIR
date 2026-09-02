import { z } from 'zod';

import type { ExecutionContextProvider } from '../../../kernel/context.js';
import {
  type ConflictError,
  type ValidationError,
  validationErrorFromZod,
} from '../../../kernel/errors.js';
import { err, type Result } from '../../../kernel/result.js';
import type { TenantScope } from '../../../kernel/scope.js';
import {
  type ExpectedVersion,
  type LedgerEvent,
  type NewLedgerEventInput,
  NewLedgerEventSchema,
  type StreamRef,
  StreamRefSchema,
} from '../domain/ledger-event.js';
import type { LedgerRepository } from './ports.js';

export interface EventLedgerDependencies {
  readonly repository: LedgerRepository;
  readonly context: ExecutionContextProvider;
}

const AppendBatchSchema = z.array(NewLedgerEventSchema).min(1, 'append at least one event');

/**
 * The application-facing ledger: validates events and their provenance,
 * stamps the current correlation id, and delegates to the repository. Reads
 * are pass-through. State is never read from here — projections own state.
 */
export class EventLedger {
  private readonly deps: EventLedgerDependencies;

  constructor(deps: EventLedgerDependencies) {
    this.deps = deps;
  }

  async append(
    scope: TenantScope,
    stream: StreamRef,
    events: readonly NewLedgerEventInput[],
    expectedVersion: ExpectedVersion,
  ): Promise<Result<LedgerEvent[], ConflictError | ValidationError>> {
    const parsedStream = StreamRefSchema.safeParse(stream);
    if (!parsedStream.success) {
      return err(
        validationErrorFromZod(
          parsedStream.error,
          'INVALID_STREAM',
          'The stream reference is invalid.',
        ),
      );
    }
    const parsedEvents = AppendBatchSchema.safeParse(events);
    if (!parsedEvents.success) {
      return err(
        validationErrorFromZod(
          parsedEvents.error,
          'INVALID_LEDGER_EVENT',
          'A ledger event is invalid.',
        ),
      );
    }
    return this.deps.repository.append(
      scope,
      parsedStream.data,
      parsedEvents.data,
      expectedVersion,
      this.deps.context.current()?.correlationId,
    );
  }

  readStream(scope: TenantScope, stream: StreamRef, fromSequence = 1): Promise<LedgerEvent[]> {
    return this.deps.repository.readStream(scope, stream, fromSequence);
  }
}
