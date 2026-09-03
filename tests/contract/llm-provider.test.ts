import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  AnthropicLlmProvider,
  FakeLlmProvider,
  LlmError,
  type LlmProviderPort,
  Secret,
  ZERO_USAGE,
  createModelRouting,
} from '@dolmir/core';

import {
  type Cassette,
  type RecordedExchange,
  loadCassette,
  recordingFetch,
  replayFetch,
  saveCassette,
} from '../support/http-cassette.js';
import {
  CONTRACT_REQUEST,
  type LlmScenario,
  describeLlmProviderContract,
} from './llm-provider.contract.js';

/**
 * Both adapters run the same contract. The Anthropic adapter replays the
 * cassettes in `__fixtures__/anthropic`; with DOLMIR_TEST_ANTHROPIC_API_KEY set,
 * the two success scenarios are re-recorded from the live API (error
 * scenarios cannot be induced on demand and stay synthesised).
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__/anthropic');
const LIVE_KEY = process.env['DOLMIR_TEST_ANTHROPIC_API_KEY'];
const RECORDABLE: ReadonlySet<LlmScenario> = new Set(['text', 'structured']);

const attempt = {
  model: 'fake-fast',
  usage: { ...ZERO_USAGE, inputTokens: 80, outputTokens: 12 },
  latencyMs: 5,
  providerRequestId: undefined,
};

describeLlmProviderContract('FakeLlmProvider', async (scenario) => {
  const provider = new FakeLlmProvider();
  switch (scenario) {
    case 'text':
      provider.enqueue({ text: 'Richiesta di offerta (RdO): 250 flange tornite S355.' });
      break;
    case 'structured':
      provider.enqueue({
        output: { category: 'rdo', evidence: 'potete inviarci un preventivo per 250 flange' },
      });
      break;
    case 'structured_invalid':
      provider.enqueue({ output: { category: 'quote_request', evidence: '' } });
      break;
    case 'rate_limited':
      provider.enqueue({ error: new LlmError('RATE_LIMITED', 'rate limited', { attempt }) });
      break;
    case 'unauthorized':
      provider.enqueue({ error: new LlmError('AUTHENTICATION', 'bad key', { attempt }) });
      break;
    case 'unavailable':
      provider.enqueue({ error: new LlmError('PROVIDER_UNAVAILABLE', 'overloaded', { attempt }) });
      break;
    case 'refusal':
      provider.enqueue({ error: new LlmError('REFUSED', 'refused', { attempt }) });
      break;
    case 'truncated':
      provider.enqueue({ error: new LlmError('TRUNCATED', 'cut', { attempt }) });
      break;
  }
  return { provider };
});

describeLlmProviderContract('AnthropicLlmProvider (recorded exchanges)', async (scenario) => {
  const path = resolve(FIXTURES, `${scenario}.json`);
  const routing = createModelRouting({ fast: 'claude-haiku-4-5' });

  if (LIVE_KEY !== undefined && RECORDABLE.has(scenario)) {
    const sink: RecordedExchange[] = [];
    const provider: LlmProviderPort = new AnthropicLlmProvider({
      apiKey: new Secret(LIVE_KEY),
      fetch: recordingFetch(globalThis.fetch, sink),
      maxRetries: 0,
      routing,
    });
    return {
      provider,
      cleanup: async () => {
        const cassette: Cassette = {
          name: scenario,
          origin: 'recorded',
          recordedAt: new Date().toISOString(),
          note: `Recorded from the live Messages API for ${CONTRACT_REQUEST.operation}.`,
          exchanges: sink,
        };
        await saveCassette(path, cassette);
      },
    };
  }

  const cassette = await loadCassette(path);
  const { fetch } = replayFetch(cassette);
  return {
    provider: new AnthropicLlmProvider({
      apiKey: new Secret('replay-no-key'),
      fetch,
      maxRetries: 0,
      routing,
    }),
  };
});
