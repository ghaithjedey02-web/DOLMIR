import type { Logger } from '../../kernel/logger.js';
import type { Telemetry, TelemetryTags } from '../../kernel/telemetry.js';

/**
 * The log-backed `Telemetry` of Phase 0 (plan §N): every counter and
 * observation becomes one structured debug line, so metrics are visible in
 * development and greppable in production until an OpenTelemetry or vendor
 * adapter replaces this class behind the same port.
 */
export class LoggingTelemetry implements Telemetry {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'telemetry' });
  }

  count(name: string, tags: TelemetryTags = {}, value = 1): void {
    this.logger.debug('metric', { metric: name, kind: 'count', value, ...tags });
  }

  observe(name: string, value: number, tags: TelemetryTags = {}): void {
    this.logger.debug('metric', { metric: name, kind: 'observe', value, ...tags });
  }
}
