import { AsyncLocalStorage } from 'node:async_hooks';

import { type ExecutionContext, type ExecutionContextProvider } from '../../kernel/context.js';
import { InternalError } from '../../kernel/errors.js';
import { newCorrelationId, newRequestId } from '../../kernel/ids.js';

/**
 * Carries the per-request `ExecutionContext` across awaits so logs, audit
 * rows and ledger events share request and correlation ids without threading
 * them through every signature.
 */
const storage = new AsyncLocalStorage<ExecutionContext>();

export function runWithContext<T>(context: ExecutionContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): ExecutionContext | undefined {
  return storage.getStore();
}

/** The provider application services depend on; backed by the async-local store. */
export const executionContextProvider: ExecutionContextProvider = { current: currentContext };

export function requireContext(): ExecutionContext {
  const context = storage.getStore();
  if (context === undefined) {
    throw new InternalError(
      'NO_EXECUTION_CONTEXT',
      'This operation requires an execution context; wrap the call in runWithContext().',
    );
  }
  return context;
}

/** Builds a fresh context; the correlation id defaults to the request id of a new chain. */
export function newExecutionContext(
  overrides: Partial<Omit<ExecutionContext, 'requestId'>> = {},
): ExecutionContext {
  const requestId = newRequestId();
  const context: ExecutionContext = {
    requestId,
    correlationId: overrides.correlationId ?? newCorrelationId(),
  };
  return {
    ...context,
    ...(overrides.tenantId === undefined ? {} : { tenantId: overrides.tenantId }),
    ...(overrides.actor === undefined ? {} : { actor: overrides.actor }),
  };
}
