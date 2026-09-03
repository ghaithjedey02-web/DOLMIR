import { z } from 'zod';

import { type Clock, systemClock } from '../../kernel/clock.js';
import { digestOf } from '../shared/canonical-json.js';
import type { LlmRequest, LlmResponse } from './port.js';

/**
 * Completion cache port (plan §I, ADR-0006 §7). A request's content hash —
 * provider, tenant, tier, prompt, options and, for structured calls, the
 * output schema — identifies a completion. In-memory in Phase 0; a shared
 * store later is configuration, not redesign. The tenant is part of the key
 * so tenants never share entries, even for identical prompts.
 */
export interface CachedCompletion {
  readonly response: LlmResponse;
  /** The validated structured output, when the cached call was structured. */
  readonly output: unknown;
  readonly storedAt: Date;
}

export interface CompletionCachePort {
  get(key: string): Promise<CachedCompletion | undefined>;
  set(key: string, value: CachedCompletion): Promise<void>;
}

/** `undefined` when the schema cannot be represented deterministically — such calls bypass the cache. */
export function completionCacheKey(
  provider: string,
  request: LlmRequest,
  schema?: z.ZodType,
): string | undefined {
  let schemaJson: unknown = null;
  if (schema !== undefined) {
    try {
      schemaJson = z.toJSONSchema(schema);
    } catch {
      return undefined;
    }
  }
  return digestOf({ provider, request, schema: schemaJson });
}

export interface InMemoryCompletionCacheOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly clock?: Clock;
}

export class InMemoryCompletionCache implements CompletionCachePort {
  private readonly entries = new Map<string, CachedCompletion>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly clock: Clock;

  constructor(options: InMemoryCompletionCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1000;
    this.ttlMs = options.ttlMs ?? 60 * 60 * 1000;
    this.clock = options.clock ?? systemClock;
  }

  get size(): number {
    return this.entries.size;
  }

  async get(key: string): Promise<CachedCompletion | undefined> {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (this.clock.now().getTime() - entry.storedAt.getTime() > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(key: string, value: CachedCompletion): Promise<void> {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }
}
