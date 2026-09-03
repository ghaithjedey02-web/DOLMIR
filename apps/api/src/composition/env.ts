import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { EnvironmentRecord } from '@dolmir/core';

/**
 * The only place in the platform that reads `process.env` (Directive §18,
 * ADR-0003; enforced by ESLint everywhere else). A `.env` file in the working
 * directory is loaded for local development without overriding variables the
 * shell already set. The record goes to `loadConfig`, which validates it and
 * wraps secrets.
 */
export function readEnvironment(options: { readonly dotenvPath?: string } = {}): EnvironmentRecord {
  const path = resolve(options.dotenvPath ?? '.env');
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
  return { ...process.env };
}
