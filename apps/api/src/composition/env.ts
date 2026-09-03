import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { EnvironmentRecord } from '@dolmir/core';

/**
 * The only place in the platform that reads `process.env` (Directive §18,
 * ADR-0003; enforced by ESLint everywhere else). A `.env` file in the working
 * directory is loaded for local development without overriding variables the
 * shell already set. The record goes to `loadConfig`, which validates it and
 * wraps secrets.
 */
export function readEnvironment(options: { readonly dotenvPath?: string } = {}): EnvironmentRecord {
  const path =
    options.dotenvPath === undefined ? findDotenv(process.cwd()) : resolve(options.dotenvPath);
  if (path !== undefined && existsSync(path)) {
    process.loadEnvFile(path);
  }
  return { ...process.env };
}

/**
 * The nearest `.env` at or above the working directory, so a command works the
 * same from the repository root and from a package inside it. The search stops
 * at the filesystem root and never leaves it.
 */
function findDotenv(from: string): string | undefined {
  let directory = resolve(from);
  for (;;) {
    const candidate = resolve(directory, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
