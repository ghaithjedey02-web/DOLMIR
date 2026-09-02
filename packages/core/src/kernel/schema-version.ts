import { z } from 'zod';

import { ValidationError } from './errors.js';
import { err, ok, type Result } from './result.js';

/**
 * Every persisted record that can evolve carries `schemaVersion`. Deciding the
 * upcasting strategy before the first record is written is what protects years
 * of ledger, audit and memory data from a schema change.
 */

export type VersionedDocument = Readonly<Record<string, unknown>> & {
  readonly schemaVersion: number;
};

export interface Upcaster {
  readonly from: number;
  readonly to: number;
  upcast(document: VersionedDocument): VersionedDocument;
}

/** Builds a strict object schema whose `schemaVersion` is pinned to a literal. */
export function versionedSchema<Shape extends z.ZodRawShape>(
  version: number,
  shape: Shape,
): z.ZodObject<Shape & { schemaVersion: z.ZodLiteral<number> }> {
  return z.object({ schemaVersion: z.literal(version), ...shape }).strict();
}

/**
 * Applies upcasters step by step until the document reaches `target`.
 * Fails as a value when a step is missing or a document is newer than known.
 */
export function upcastToVersion(
  document: VersionedDocument,
  target: number,
  upcasters: readonly Upcaster[],
): Result<VersionedDocument, ValidationError> {
  let current = document;
  const seen = new Set<number>();
  while (current.schemaVersion !== target) {
    if (current.schemaVersion > target) {
      return err(
        new ValidationError(
          'SCHEMA_VERSION_TOO_NEW',
          `Document schema version ${current.schemaVersion} is newer than the supported version ${target}.`,
        ),
      );
    }
    if (seen.has(current.schemaVersion)) {
      return err(
        new ValidationError(
          'UPCASTER_CYCLE',
          `Upcasters loop at version ${current.schemaVersion}.`,
        ),
      );
    }
    seen.add(current.schemaVersion);
    const step = upcasters.find((candidate) => candidate.from === current.schemaVersion);
    if (step === undefined) {
      return err(
        new ValidationError(
          'UPCASTER_MISSING',
          `No upcaster from schema version ${current.schemaVersion}.`,
        ),
      );
    }
    const next = step.upcast(current);
    if (next.schemaVersion !== step.to) {
      return err(
        new ValidationError(
          'UPCASTER_INVALID',
          `Upcaster ${step.from}→${step.to} produced version ${next.schemaVersion}.`,
        ),
      );
    }
    current = next;
  }
  return ok(current);
}
