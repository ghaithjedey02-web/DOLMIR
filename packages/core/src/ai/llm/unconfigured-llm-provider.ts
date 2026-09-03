import type { z } from 'zod';

import { err, type Result } from '../../kernel/result.js';
import {
  LlmError,
  type LlmProviderPort,
  type LlmRequest,
  type LlmResponse,
  type StructuredLlmResponse,
} from './port.js';

/**
 * The provider used when `DOLMIR_AI_PROVIDER=none`: the platform boots and
 * serves everything that needs no model, and every model call fails as a
 * value that says so. Readiness reports "AI: not configured" instead of
 * pretending.
 */
export class UnconfiguredLlmProvider implements LlmProviderPort {
  readonly name = 'none';
  readonly capabilities = { structuredOutput: false, vision: false } as const;

  async complete(_request: LlmRequest): Promise<Result<LlmResponse, LlmError>> {
    return err(this.error());
  }

  async completeStructured<T>(
    _request: LlmRequest,
    _schema: z.ZodType<T>,
  ): Promise<Result<StructuredLlmResponse<T>, LlmError>> {
    return err(this.error());
  }

  private error(): LlmError {
    return new LlmError(
      'PROVIDER_NOT_CONFIGURED',
      'No AI provider is configured (DOLMIR_AI_PROVIDER=none).',
    );
  }
}
