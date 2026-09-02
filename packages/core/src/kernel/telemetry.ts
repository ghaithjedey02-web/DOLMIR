/**
 * The telemetry port: counters and observations with tags. Log-backed in
 * Phase 0; OpenTelemetry or a vendor become adapters later without touching
 * the callers.
 */

export type TelemetryTags = Readonly<Record<string, string | number | boolean>>;

export interface Telemetry {
  /** Increments a counter (default by 1). */
  count(name: string, tags?: TelemetryTags, value?: number): void;
  /** Records one observation of a value (latency, tokens, cost…). */
  observe(name: string, value: number, tags?: TelemetryTags): void;
}

export const noopTelemetry: Telemetry = {
  count: () => undefined,
  observe: () => undefined,
};

export interface TelemetryEvent {
  readonly kind: 'count' | 'observe';
  readonly name: string;
  readonly value: number;
  readonly tags: TelemetryTags;
}

export class InMemoryTelemetry implements Telemetry {
  readonly events: TelemetryEvent[] = [];

  count(name: string, tags: TelemetryTags = {}, value = 1): void {
    this.events.push({ kind: 'count', name, value, tags });
  }

  observe(name: string, value: number, tags: TelemetryTags = {}): void {
    this.events.push({ kind: 'observe', name, value, tags });
  }

  total(name: string): number {
    return this.events
      .filter((event) => event.kind === 'count' && event.name === name)
      .reduce((sum, event) => sum + event.value, 0);
  }
}
