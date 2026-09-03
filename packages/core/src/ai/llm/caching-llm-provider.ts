import type { z } from 'zod';

import { type Clock, systemClock } from '../../kernel/clock.js';
import { ok, type Result } from '../../kernel/result.js';
import { type CompletionCachePort, completionCacheKey } from './cache.js';
import {
  type LlmError,
  type LlmProviderPort,
  type LlmRequest,
  type LlmResponse,
  type StructuredLlmResponse,
  ZERO_USAGE,
} from './port.js';

export interface CachingLlmProviderDependencies {
  readonly inner: LlmProviderPort;
  readonly cache: CompletionCachePort;
  readonly clock?: Clock;
}

/**
 * Serves repeated identical requests from the cache. A hit reports
 * `cached: true` with zero usage, so the usage recorder can show what the
 * cache saved. Only complete (`end_turn`) successes are stored.
 */
export class CachingLlmProvider implements LlmProviderPort {
  readonly name: string;
  readonly capabilities: LlmProviderPort['capabilities'];
  private readonly inner: LlmProviderPort;
  private readonly cache: CompletionCachePort;
  private readonly clock: Clock;

  constructor(deps: CachingLlmProviderDependencies) {
    this.inner = deps.inner;
    this.cache = deps.cache;
    this.clock = deps.clock ?? systemClock;
    this.name = deps.inner.name;
    this.capabilities = deps.inner.capabilities;
  }

  async complete(request: LlmRequest): Promise<Result<LlmResponse, LlmError>> {
    const key = completionCacheKey(this.inner.name, request);
    if (key !== undefined) {
      const hit = await this.cache.get(key);
      if (hit !== undefined) return ok(asHit(hit.response));
    }
    const result = await this.inner.complete(request);
    if (result.ok && key !== undefined && result.value.stopReason === 'end_turn') {
      await this.cache.set(key, {
        response: result.value,
        output: undefined,
        storedAt: this.clock.now(),
      });
    }
    return result;
  }

  async completeStructured<T>(
    request: LlmRequest,
    schema: z.ZodType<T>,
  ): Promise<Result<StructuredLlmResponse<T>, LlmError>> {
    const key = completionCacheKey(this.inner.name, request, schema);
    if (key !== undefined) {
      const hit = await this.cache.get(key);
      if (hit !== undefined) {
        // The entry was stored after validation against this same schema.
        const revalidated = schema.safeParse(hit.output);
        if (revalidated.success) {
          return ok({ ...asHit(hit.response), output: revalidated.data });
        }
      }
    }
    const result = await this.inner.completeStructured(request, schema);
    if (result.ok && key !== undefined && result.value.stopReason === 'end_turn') {
      await this.cache.set(key, {
        response: result.value,
        output: result.value.output,
        storedAt: this.clock.now(),
      });
    }
    return result;
  }
}

function asHit(response: LlmResponse): LlmResponse {
  return { ...response, cached: true, usage: ZERO_USAGE, latencyMs: 0 };
}
