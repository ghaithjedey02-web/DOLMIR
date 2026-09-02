import { z } from 'zod';

import { ActorSchema } from '../../../kernel/context.js';
import {
  CorrelationIdSchema,
  OrganizationIdSchema,
  RequestIdSchema,
  UuidSchema,
} from '../../../kernel/ids.js';

/**
 * One line of the audit trail: who did what, to which target, with which
 * outcome, under which request. Immutable once written.
 */
export const AuditOutcome = { SUCCESS: 'success', FAILURE: 'failure', DENIED: 'denied' } as const;
export const AuditOutcomeSchema = z.enum(['success', 'failure', 'denied']);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

export const AuditTargetSchema = z
  .object({
    type: z.string().trim().min(1).max(100),
    id: z.string().trim().min(1).max(255),
  })
  .strict();
export type AuditTarget = z.infer<typeof AuditTargetSchema>;

/** `resource.verb`, lowercase: `organization.provisioned`, `tool.executed`, `system_scope.opened`. */
export const AuditActionSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'action must look like resource.verb');

const entryShape = {
  /** `null` for platform-level events that have no tenant yet. */
  organizationId: OrganizationIdSchema.nullable(),
  actor: ActorSchema,
  action: AuditActionSchema,
  target: AuditTargetSchema.nullable(),
  outcome: AuditOutcomeSchema,
  details: z.record(z.string(), z.unknown()),
};

export const NewAuditEntrySchema = z
  .object({
    ...entryShape,
    target: AuditTargetSchema.nullable().default(null),
    outcome: AuditOutcomeSchema.default('success'),
    details: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type NewAuditEntry = z.infer<typeof NewAuditEntrySchema>;
export type NewAuditEntryInput = z.input<typeof NewAuditEntrySchema>;

export const AuditEntrySchema = z
  .object({
    ...entryShape,
    id: UuidSchema,
    requestId: RequestIdSchema.nullable(),
    correlationId: CorrelationIdSchema.nullable(),
    occurredAt: z.date(),
  })
  .strict();
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
