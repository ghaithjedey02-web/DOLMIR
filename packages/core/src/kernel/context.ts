import { z } from 'zod';

import { CorrelationIdSchema, OrganizationIdSchema, RequestIdSchema } from './ids.js';

/**
 * Who acted. Used by the audit log, the event ledger's provenance and tool
 * execution. `SYSTEM` is a scheduled or internal process; `SERVICE` is a
 * machine caller (e.g. an n8n workflow) authenticated by a signed request;
 * `AI` is a model acting through a permission-bounded tool on behalf of a
 * principal.
 */
export const ActorType = {
  USER: 'USER',
  SERVICE: 'SERVICE',
  SYSTEM: 'SYSTEM',
  AI: 'AI',
} as const;
export const ActorTypeSchema = z.enum(['USER', 'SERVICE', 'SYSTEM', 'AI']);
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const ActorSchema = z
  .object({
    type: ActorTypeSchema,
    /** Stable identifier of the actor (user id, service key id, process name, model id). */
    id: z.string().trim().min(1),
    /** For AI actors: the principal on whose behalf the model acts. */
    onBehalfOf: z.string().trim().min(1).optional(),
  })
  .strict();
export type Actor = z.infer<typeof ActorSchema>;

export const SYSTEM_ACTOR: Actor = { type: ActorType.SYSTEM, id: 'dolmir' };

/**
 * The per-request execution context: correlation for logs, audit and ledger.
 * Carried through `AsyncLocalStorage` by the infrastructure layer; the kernel
 * only defines its shape.
 */
export const ExecutionContextSchema = z
  .object({
    requestId: RequestIdSchema,
    correlationId: CorrelationIdSchema,
    tenantId: OrganizationIdSchema.optional(),
    actor: ActorSchema.optional(),
  })
  .strict();
export type ExecutionContext = z.infer<typeof ExecutionContextSchema>;

/** Read access to the current context, so application services can stamp records without depending on Node internals. */
export interface ExecutionContextProvider {
  current(): ExecutionContext | undefined;
}

export const noExecutionContext: ExecutionContextProvider = { current: () => undefined };
