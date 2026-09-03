import type { AiConfig } from '../../infrastructure/config/schema.js';
import type { Clock } from '../../kernel/clock.js';
import { InternalError } from '../../kernel/errors.js';
import { FakeLlmProvider } from '../llm/fake-llm-provider.js';
import { createModelRouting } from '../llm/model-routing.js';
import type { LlmProviderPort } from '../llm/port.js';
import { UnconfiguredLlmProvider } from '../llm/unconfigured-llm-provider.js';
import { AnthropicLlmProvider, type HttpFetch } from './anthropic/anthropic-llm-provider.js';

export interface CreateLlmProviderOptions {
  readonly fetch?: HttpFetch;
  readonly clock?: Clock;
}

/** Selects the provider named by configuration. A second real provider is a new case here. */
export function createLlmProvider(
  config: AiConfig,
  options: CreateLlmProviderOptions = {},
): LlmProviderPort {
  switch (config.provider) {
    case 'none':
      return new UnconfiguredLlmProvider();
    case 'fake':
      return new FakeLlmProvider();
    case 'anthropic': {
      if (config.anthropic === undefined) {
        throw new InternalError(
          'AI_PROVIDER_MISCONFIGURED',
          'DOLMIR_AI_PROVIDER=anthropic requires DOLMIR_AI_ANTHROPIC_API_KEY.',
        );
      }
      return new AnthropicLlmProvider({
        apiKey: config.anthropic.apiKey,
        routing: createModelRouting(config.models),
        ...(config.anthropic.baseUrl === undefined ? {} : { baseUrl: config.anthropic.baseUrl }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });
    }
  }
}
