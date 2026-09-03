import { z } from 'zod';

import { ActorSchema } from '../../../kernel/context.js';
import { CorrelationIdSchema, OrganizationIdSchema, UuidSchema } from '../../../kernel/ids.js';
import { SourceKindSchema } from '../../../kernel/source-kind.js';

/**
 * The event ledger's vocabulary (ADR-0004). Every event says where the fact
 * came from (`provenance`); a fact without provenance is unconstructible.
 * `SourceKind` itself lives in the kernel, shared with ingested documents.
 */

const nonEmpty = (message: string) => z.string().trim().min(1, message);

export const ProvenanceSchema = z
  .object({
    sourceKind: SourceKindSchema,
    /** Document id, message id, ERP record reference, user id, workflow run id… */
    sourceRef: nonEmpty('Provenance.sourceRef must be non-empty.'),
    actor: ActorSchema,
    /** Evidence references (document spans, computations) supporting the fact. */
    evidenceRefs: z.array(nonEmpty('Evidence references must be non-empty.')).default([]),
    /** The component that recorded the event (e.g. `intake.pipeline`, `api.ingest`). */
    recordedBy: nonEmpty('Provenance.recordedBy must be non-empty.'),
  })
  .strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type ProvenanceInput = z.input<typeof ProvenanceSchema>;

/** A stream groups the events of one thing: `document/<id>`, `case/<id>`, `material/<code>`. */
export const StreamRefSchema = z
  .object({
    type: z.string().regex(/^[a-z][a-z0-9_]*$/, 'stream type must be snake_case'),
    id: z.string().trim().min(1).max(255),
  })
  .strict();
export type StreamRef = z.infer<typeof StreamRefSchema>;

export const NewLedgerEventSchema = z
  .object({
    /** PascalCase, past tense: `DocumentReceived`, `QuantityCorrected`. */
    eventType: z.string().regex(/^[A-Z][A-Za-z0-9]*$/, 'event type must be PascalCase'),
    schemaVersion: z.number().int().min(1),
    payload: z.record(z.string(), z.unknown()),
    provenance: ProvenanceSchema,
    /** When the fact happened in the world (the ledger records `recordedAt` itself). */
    occurredAt: z.date(),
    /** The event that caused this one, when known. */
    causationId: UuidSchema.optional(),
    /** Client-supplied key making the append idempotent within the tenant. */
    idempotencyKey: z.string().trim().min(1).max(255).optional(),
  })
  .strict();
export type NewLedgerEvent = z.infer<typeof NewLedgerEventSchema>;
export type NewLedgerEventInput = z.input<typeof NewLedgerEventSchema>;

export const LedgerEventSchema = z
  .object({
    id: UuidSchema,
    organizationId: OrganizationIdSchema,
    stream: StreamRefSchema,
    streamSequence: z.number().int().min(1),
    globalSequence: z.number().int().min(1),
    eventType: z.string(),
    schemaVersion: z.number().int().min(1),
    payload: z.record(z.string(), z.unknown()),
    provenance: ProvenanceSchema,
    occurredAt: z.date(),
    recordedAt: z.date(),
    correlationId: CorrelationIdSchema.nullable(),
    causationId: UuidSchema.nullable(),
    idempotencyKey: z.string().nullable(),
  })
  .strict();
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;

/**
 * Optimistic concurrency: the stream version the caller observed. A number is
 * the exact current length; `'none'` means the stream must not exist yet;
 * `'any'` appends regardless (for streams where ordering conflicts are
 * impossible by construction).
 */
export type ExpectedVersion = number | 'none' | 'any';
