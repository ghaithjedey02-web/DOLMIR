import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { validationErrorFromZod, type ValidationError } from './errors.js';
import { err, ok, type Result } from './result.js';

/**
 * Identities are branded strings: an `OrganizationId` cannot be passed where a
 * `UserId` is expected, and neither can an arbitrary string. Schemas double as
 * validators at every boundary (HTTP, database rows, LLM tool inputs).
 */

export const UuidSchema = z.uuid();
export type Uuid = z.infer<typeof UuidSchema>;

export const OrganizationIdSchema = z.uuid().brand<'OrganizationId'>();
export type OrganizationId = z.infer<typeof OrganizationIdSchema>;

export const UserIdSchema = z.uuid().brand<'UserId'>();
export type UserId = z.infer<typeof UserIdSchema>;

export const RequestIdSchema = z.uuid().brand<'RequestId'>();
export type RequestId = z.infer<typeof RequestIdSchema>;

export const CorrelationIdSchema = z.uuid().brand<'CorrelationId'>();
export type CorrelationId = z.infer<typeof CorrelationIdSchema>;

export const DocumentIdSchema = z.uuid().brand<'DocumentId'>();
export type DocumentId = z.infer<typeof DocumentIdSchema>;

export const EntityIdSchema = z.uuid().brand<'EntityId'>();
export type EntityId = z.infer<typeof EntityIdSchema>;

export const CaseIdSchema = z.uuid().brand<'CaseId'>();
export type CaseId = z.infer<typeof CaseIdSchema>;

export const ConnectionIdSchema = z.uuid().brand<'ConnectionId'>();
export type ConnectionId = z.infer<typeof ConnectionIdSchema>;

export function newUuid(): Uuid {
  return randomUUID();
}

export function newOrganizationId(): OrganizationId {
  return OrganizationIdSchema.parse(randomUUID());
}

export function newUserId(): UserId {
  return UserIdSchema.parse(randomUUID());
}

export function newRequestId(): RequestId {
  return RequestIdSchema.parse(randomUUID());
}

export function newCorrelationId(): CorrelationId {
  return CorrelationIdSchema.parse(randomUUID());
}

export function newDocumentId(): DocumentId {
  return DocumentIdSchema.parse(randomUUID());
}

export function newEntityId(): EntityId {
  return EntityIdSchema.parse(randomUUID());
}

export function newCaseId(): CaseId {
  return CaseIdSchema.parse(randomUUID());
}

export function newConnectionId(): ConnectionId {
  return ConnectionIdSchema.parse(randomUUID());
}

/** Validates an untrusted value against an id schema, failing as a value. */
export function parseId<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  name: string,
): Result<z.output<S>, ValidationError> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return err(
      validationErrorFromZod(parsed.error, 'INVALID_ID', `${name} is not a valid identifier.`),
    );
  }
  return ok(parsed.data);
}
