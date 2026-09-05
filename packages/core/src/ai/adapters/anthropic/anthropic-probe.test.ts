import { describe, expect, it } from 'vitest';

import { Secret } from '../../../infrastructure/config/secret.js';
import type { HttpFetch } from './anthropic-llm-provider.js';
import { probeAnthropic } from './anthropic-probe.js';

/**
 * The probe never reaches the network here: `fetch` is injected, as it is for
 * the provider's own contract tests. What is under test is the shape of the
 * request and the classification of each way the provider can answer.
 */
const KEY = 'sk-ant-api03-this-is-the-secret-under-test';

function answering(
  status: number,
  body: unknown,
): { fetch: HttpFetch; calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: HttpFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}

const modelsPage = {
  data: [
    {
      type: 'model',
      id: 'claude-opus-5',
      display_name: 'Claude Opus 5',
      created_at: '2026-04-01T00:00:00Z',
    },
  ],
  has_more: false,
  first_id: 'claude-opus-5',
  last_id: 'claude-opus-5',
};

describe('probeAnthropic', () => {
  it('asks for one model, with the key, and generates nothing', async () => {
    const { fetch, calls } = answering(200, modelsPage);
    const result = await probeAnthropic({ apiKey: new Secret(KEY), fetch });

    expect(result).toMatchObject({ ok: true, models: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(/\/v1\/models\?limit=1$/);
    expect(calls[0]?.headers['x-api-key']).toBe(KEY);
    expect(calls[0]?.headers['anthropic-version']).toBeDefined();
  });

  it('classifies a refused key as unauthorized, and never repeats the key', async () => {
    const { fetch } = answering(401, {
      type: 'error',
      error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` },
    });
    const result = await probeAnthropic({ apiKey: new Secret(KEY), fetch });

    expect(result).toMatchObject({ ok: false, kind: 'unauthorized', status: 401 });
    if (!result.ok) {
      expect(result.detail).not.toContain(KEY);
      expect(result.detail).toContain('[redacted]');
    }
  });

  it('classifies a provider that does not answer as unreachable', async () => {
    const failing: HttpFetch = async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    };
    const result = await probeAnthropic({ apiKey: new Secret(KEY), fetch: failing });
    expect(result).toMatchObject({ ok: false, kind: 'unreachable', status: undefined });
  });

  it('classifies any other refusal by its status', async () => {
    const { fetch } = answering(529, {
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    });
    const result = await probeAnthropic({ apiKey: new Secret(KEY), fetch });
    expect(result).toMatchObject({ ok: false, kind: 'rejected', status: 529 });
  });

  it('reports an empty model list rather than treating it as reachability', async () => {
    const { fetch } = answering(200, { ...modelsPage, data: [], first_id: null, last_id: null });
    const result = await probeAnthropic({ apiKey: new Secret(KEY), fetch });
    expect(result).toMatchObject({ ok: true, models: 0 });
  });
});
