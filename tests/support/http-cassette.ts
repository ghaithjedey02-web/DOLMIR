import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { HttpFetch } from '@dolmir/core';

/**
 * Recorded HTTP exchanges for provider adapters. Replay needs no key and no
 * network; recording wraps the real `fetch` and writes what it saw.
 *
 * Honesty note: a cassette says whether it was `recorded` from the live API
 * or `synthesised` from the documented response shape. Synthesised cassettes
 * prove the adapter's mapping logic; only recorded ones prove the wire format.
 */
export interface RecordedExchange {
  readonly request: { readonly method: string; readonly url: string; readonly body: unknown };
  readonly response:
    | {
        readonly status: number;
        readonly headers: Readonly<Record<string, string>>;
        readonly body: unknown;
      }
    | { readonly networkError: string };
}

export interface Cassette {
  readonly name: string;
  /** `recorded` from the live API, or `synthesised` from the documented schema. */
  readonly origin: 'recorded' | 'synthesised';
  readonly recordedAt?: string;
  readonly note?: string;
  readonly exchanges: readonly RecordedExchange[];
}

export interface CapturedCall {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

export function replayFetch(cassette: Cassette): { fetch: HttpFetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const remaining = [...cassette.exchanges];
  const fetch: HttpFetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: parseBody(init?.body) });
    const exchange = remaining.shift();
    if (exchange === undefined) {
      throw new Error(
        `cassette "${cassette.name}" exhausted after ${cassette.exchanges.length} exchange(s)`,
      );
    }
    if (
      method !== exchange.request.method ||
      new URL(url).pathname !== new URL(exchange.request.url).pathname
    ) {
      throw new Error(
        `cassette "${cassette.name}" expected ${exchange.request.method} ${exchange.request.url}, got ${method} ${url}`,
      );
    }
    if ('networkError' in exchange.response) {
      throw new TypeError(exchange.response.networkError);
    }
    return new Response(JSON.stringify(exchange.response.body), {
      status: exchange.response.status,
      headers: exchange.response.headers,
    });
  };
  return { fetch, calls };
}

/** Wraps a real fetch and appends every exchange to `sink`. Secrets in headers are never recorded. */
export function recordingFetch(real: HttpFetch, sink: RecordedExchange[]): HttpFetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? 'GET';
    const response = await real(input, init);
    const copy = response.clone();
    const text = await copy.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep the raw text
    }
    const headers: Record<string, string> = {};
    for (const name of ['content-type', 'request-id', 'retry-after']) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    sink.push({
      request: { method, url, body: parseBody(init?.body) },
      response: { status: response.status, headers, body },
    });
    return response;
  };
}

export async function loadCassette(path: string): Promise<Cassette> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  return raw as Cassette;
}

export async function saveCassette(path: string, cassette: Cassette): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cassette, null, 2)}\n`, 'utf8');
}

function parseBody(body: RequestInit['body'] | undefined): unknown {
  if (typeof body !== 'string') return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
