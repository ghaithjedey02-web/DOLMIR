import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { z } from 'zod';

import type { Clock } from '../../kernel/clock.js';
import { systemClock } from '../../kernel/clock.js';
import { type DomainError, InfrastructureError, InternalError } from '../../kernel/errors.js';
import type { OrganizationId } from '../../kernel/ids.js';
import {
  type ObjectKey,
  type ObjectStoragePort,
  type PutObjectInput,
  type StoredObject,
  type StoredObjectRef,
  StoredObjectRefSchema,
} from '../../kernel/object-storage.js';
import { err, ok, type Result } from '../../kernel/result.js';
import { checkKey, describePut } from './validation.js';

/**
 * Local filesystem storage for development and single-node deployments.
 * Layout: `<root>/<tenantId>/<namespace>/<sha256>` for the bytes and
 * `<…>.meta.json` for the metadata. Writes go to a temporary file and are
 * renamed into place, so a crash never leaves a half-written object that
 * would later be served as real content.
 */
const MetaFileSchema = StoredObjectRefSchema.omit({ storedAt: true }).extend({
  storedAt: z.iso.datetime(),
});

export class LocalFileSystemObjectStorage implements ObjectStoragePort {
  private readonly root: string;
  private readonly clock: Clock;

  constructor(root: string, clock: Clock = systemClock) {
    this.root = resolve(root);
    this.clock = clock;
  }

  async put(input: PutObjectInput): Promise<Result<StoredObjectRef, DomainError>> {
    const described = describePut(input, this.clock);
    if (!described.ok) return described;
    const ref = described.value;
    const path = this.pathFor(ref.key);
    try {
      const existing = await this.readMeta(path);
      if (existing !== undefined) return ok(existing);

      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temp, input.body, { flag: 'wx' });
      await writeFile(
        `${temp}.meta.json`,
        JSON.stringify({ ...ref, storedAt: ref.storedAt.toISOString() }),
        {
          flag: 'wx',
        },
      );
      await rename(`${temp}.meta.json`, `${path}.meta.json`);
      await rename(temp, path);
      return ok(ref);
    } catch (error) {
      await rm(path, { force: true }).catch(() => undefined);
      return err(
        new InfrastructureError('OBJECT_STORAGE_WRITE_FAILED', 'The object could not be stored.', {
          cause: error,
        }),
      );
    }
  }

  async get(
    tenantId: OrganizationId,
    key: ObjectKey,
  ): Promise<Result<StoredObject | undefined, DomainError>> {
    const checked = checkKey(tenantId, key);
    if (!checked.ok) return err(checked.error);
    const path = this.pathFor(checked.value);
    try {
      const ref = await this.readMeta(path);
      if (ref === undefined) return ok(undefined);
      const body = new Uint8Array(await readFile(path));
      return ok({ ref, body });
    } catch (error) {
      return err(
        new InfrastructureError('OBJECT_STORAGE_READ_FAILED', 'The object could not be read.', {
          cause: error,
        }),
      );
    }
  }

  async head(
    tenantId: OrganizationId,
    key: ObjectKey,
  ): Promise<Result<StoredObjectRef | undefined, DomainError>> {
    const checked = checkKey(tenantId, key);
    if (!checked.ok) return err(checked.error);
    try {
      return ok(await this.readMeta(this.pathFor(checked.value)));
    } catch (error) {
      return err(
        new InfrastructureError('OBJECT_STORAGE_READ_FAILED', 'The object could not be read.', {
          cause: error,
        }),
      );
    }
  }

  private pathFor(key: ObjectKey): string {
    // The key grammar admits only [0-9a-f-]/[a-z0-9_-]/[0-9a-f] segments, so it
    // cannot escape the root; the resolve check is defence in depth.
    const path = resolve(this.root, ...key.split('/'));
    if (!path.startsWith(this.root + sep)) {
      throw new InternalError(
        'OBJECT_PATH_ESCAPE',
        'Refusing an object path outside the storage root.',
      );
    }
    return path;
  }

  private async readMeta(path: string): Promise<StoredObjectRef | undefined> {
    try {
      await stat(path);
    } catch {
      return undefined;
    }
    const raw: unknown = JSON.parse(await readFile(`${path}.meta.json`, 'utf8'));
    const meta = MetaFileSchema.parse(raw);
    return StoredObjectRefSchema.parse({ ...meta, storedAt: new Date(meta.storedAt) });
  }

  /** Where a key would live; exposed for diagnostics and tests. */
  locate(key: ObjectKey): string {
    return join(this.root, ...key.split('/'));
  }
}
