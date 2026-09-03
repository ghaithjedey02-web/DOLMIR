import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted recursively, so equal values hash
 * equal. Used for completion cache keys, tool input digests in audit entries
 * and approval matching.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortKeys);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of entries) result[key] = sortKeys(entry);
  return result;
}
