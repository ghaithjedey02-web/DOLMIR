import type { Clock } from '../../kernel/clock.js';
import type { ObjectStoragePort } from '../../kernel/object-storage.js';
import type { StorageConfig } from '../config/schema.js';
import { InMemoryObjectStorage } from './in-memory-object-storage.js';
import { LocalFileSystemObjectStorage } from './local-fs-object-storage.js';

export { InMemoryObjectStorage } from './in-memory-object-storage.js';
export { LocalFileSystemObjectStorage } from './local-fs-object-storage.js';

/** Selects the adapter named by configuration. A cloud adapter is a new case here, not a redesign. */
export function createObjectStorage(config: StorageConfig, clock: Clock): ObjectStoragePort {
  switch (config.driver) {
    case 'memory':
      return new InMemoryObjectStorage(clock);
    case 'local':
      return new LocalFileSystemObjectStorage(config.localRoot, clock);
  }
}
