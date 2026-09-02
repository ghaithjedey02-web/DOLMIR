import { z } from 'zod';

import type { Clock } from '../../kernel/clock.js';
import { ForbiddenError, ValidationError, validationErrorFromZod } from '../../kernel/errors.js';
import type { OrganizationId } from '../../kernel/ids.js';
import {
  ObjectKeySchema,
  type PutObjectInput,
  StorageNamespaceSchema,
  type StoredObjectRef,
  StoredObjectRefSchema,
  contentHashOf,
  keyBelongsToTenant,
  objectKeyFor,
} from '../../kernel/object-storage.js';
import { err, ok, type Result } from '../../kernel/result.js';

/** Validation shared by every object-storage adapter, so their behaviour matches the contract suite. */

const PutInputSchema = z.object({
  namespace: StorageNamespaceSchema,
  contentType: z.string().trim().min(1).max(255),
  filename: z.string().trim().min(1).max(255).optional(),
});

export function describePut(
  input: PutObjectInput,
  clock: Clock,
): Result<StoredObjectRef, ValidationError> {
  const parsed = PutInputSchema.safeParse({
    namespace: input.namespace,
    contentType: input.contentType,
    ...(input.filename === undefined ? {} : { filename: input.filename }),
  });
  if (!parsed.success) {
    return err(
      validationErrorFromZod(parsed.error, 'INVALID_OBJECT', 'The object metadata is invalid.'),
    );
  }
  if (input.body.byteLength === 0) {
    return err(new ValidationError('EMPTY_OBJECT', 'An object must have at least one byte.'));
  }
  const contentHash = contentHashOf(input.body);
  return ok(
    StoredObjectRefSchema.parse({
      key: objectKeyFor(input.tenantId, parsed.data.namespace, contentHash),
      tenantId: input.tenantId,
      namespace: parsed.data.namespace,
      contentHash,
      sizeBytes: input.body.byteLength,
      contentType: parsed.data.contentType,
      ...(parsed.data.filename === undefined ? {} : { filename: parsed.data.filename }),
      storedAt: clock.now(),
    }),
  );
}

export function checkKey(
  tenantId: OrganizationId,
  key: string,
): Result<string, ValidationError | ForbiddenError> {
  const parsed = ObjectKeySchema.safeParse(key);
  if (!parsed.success) {
    return err(
      validationErrorFromZod(parsed.error, 'INVALID_OBJECT_KEY', 'The object key is malformed.'),
    );
  }
  if (!keyBelongsToTenant(parsed.data, tenantId)) {
    return err(
      new ForbiddenError('OBJECT_TENANT_MISMATCH', 'The object does not belong to this tenant.'),
    );
  }
  return ok(parsed.data);
}
