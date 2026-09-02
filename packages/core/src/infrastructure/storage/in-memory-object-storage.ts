import type { Clock } from '../../kernel/clock.js';
import { systemClock } from '../../kernel/clock.js';
import type { DomainError } from '../../kernel/errors.js';
import type { OrganizationId } from '../../kernel/ids.js';
import type {
  ObjectKey,
  ObjectStoragePort,
  PutObjectInput,
  StoredObject,
  StoredObjectRef,
} from '../../kernel/object-storage.js';
import { err, ok, type Result } from '../../kernel/result.js';
import { checkKey, describePut } from './validation.js';

/** Process-local storage for tests and ephemeral development. */
export class InMemoryObjectStorage implements ObjectStoragePort {
  private readonly objects = new Map<string, StoredObject>();
  private readonly clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  async put(input: PutObjectInput): Promise<Result<StoredObjectRef, DomainError>> {
    const described = describePut(input, this.clock);
    if (!described.ok) return described;
    const existing = this.objects.get(described.value.key);
    if (existing !== undefined) return ok(existing.ref);
    const stored: StoredObject = { ref: described.value, body: Uint8Array.from(input.body) };
    this.objects.set(stored.ref.key, stored);
    return ok(stored.ref);
  }

  async get(
    tenantId: OrganizationId,
    key: ObjectKey,
  ): Promise<Result<StoredObject | undefined, DomainError>> {
    const checked = checkKey(tenantId, key);
    if (!checked.ok) return err(checked.error);
    const stored = this.objects.get(checked.value);
    return ok(
      stored === undefined ? undefined : { ref: stored.ref, body: Uint8Array.from(stored.body) },
    );
  }

  async head(
    tenantId: OrganizationId,
    key: ObjectKey,
  ): Promise<Result<StoredObjectRef | undefined, DomainError>> {
    const checked = checkKey(tenantId, key);
    if (!checked.ok) return err(checked.error);
    return ok(this.objects.get(checked.value)?.ref);
  }

  get size(): number {
    return this.objects.size;
  }
}
