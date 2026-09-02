import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryObjectStorage, LocalFileSystemObjectStorage } from '@dolmir/core';

import { describeObjectStorageContract } from './object-storage.contract.js';

describeObjectStorageContract('in-memory', async (clock) => ({
  storage: new InMemoryObjectStorage(clock),
  cleanup: async () => undefined,
}));

describeObjectStorageContract('local filesystem', async (clock) => {
  const root = await mkdtemp(join(tmpdir(), 'dolmir-storage-'));
  return {
    storage: new LocalFileSystemObjectStorage(root, clock),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
});
