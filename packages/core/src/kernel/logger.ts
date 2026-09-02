/**
 * The logging port. Modules log through this interface only; the pino-backed
 * implementation lives in `infrastructure/logging`, where redaction and the
 * request-context mixin are applied. Operational logs answer "was the system
 * healthy"; they never carry domain records (audit, ledger, usage have tables).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};

export interface CapturedLogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/** Collects records in memory so tests can assert on what was logged. */
export class CapturingLogger implements Logger {
  readonly records: CapturedLogRecord[] = [];
  private readonly bindings: LogFields;

  constructor(bindings: LogFields = {}, records?: CapturedLogRecord[]) {
    this.bindings = bindings;
    if (records !== undefined) this.records = records;
  }

  debug(message: string, fields: LogFields = {}): void {
    this.push('debug', message, fields);
  }

  info(message: string, fields: LogFields = {}): void {
    this.push('info', message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.push('warn', message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.push('error', message, fields);
  }

  child(bindings: LogFields): Logger {
    return new CapturingLogger({ ...this.bindings, ...bindings }, this.records);
  }

  private push(level: LogLevel, message: string, fields: LogFields): void {
    this.records.push({ level, message, fields: { ...this.bindings, ...fields } });
  }
}
