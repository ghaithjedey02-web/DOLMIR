import {
  type DestinationStream,
  type Logger as PinoLogger,
  pino,
  stdTimeFunctions,
  transport as pinoTransport,
} from 'pino';

import { type LogFields, type Logger, type LogLevel } from '../../kernel/logger.js';
import { redactForLog } from '../../kernel/redaction.js';
import { currentContext } from '../context/execution-context.js';

/**
 * The pino-backed `Logger` (Directive §18 "safe logging", plan §N).
 *
 * - Every record is JSON (pretty-printed only when asked, for development).
 * - Fields pass through `redactForLog`: secret-looking keys are replaced,
 *   strings lose emails, phones, VAT numbers, fiscal codes and IBANs.
 * - The current `ExecutionContext` (request, correlation, tenant, actor) is
 *   mixed into every line automatically.
 * - pino's own `redact` covers well-known header and credential paths as a
 *   second layer.
 */

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly format: 'json' | 'pretty';
  /** Static bindings for every line, e.g. `{ service: 'dolmir-api', version }`. */
  readonly base?: LogFields;
  /** Test hook: write to this stream instead of stdout. */
  readonly destination?: DestinationStream;
}

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'headers.authorization',
  'headers.cookie',
  '*.apiKey',
  '*.password',
  '*.secret',
  '*.token',
  '*.authorization',
];

export function createPinoLogger(options: LoggerOptions): Logger {
  const transport =
    options.destination ??
    (options.format === 'pretty'
      ? pinoTransport({
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
        })
      : undefined);

  const root = pino(
    {
      level: options.level,
      base: { ...(options.base ?? {}) },
      timestamp: stdTimeFunctions.isoTime,
      messageKey: 'message',
      formatters: {
        level: (label) => ({ level: label }),
      },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      mixin: () => contextFields(),
    },
    transport,
  );
  return wrap(root);
}

function contextFields(): Record<string, unknown> {
  const context = currentContext();
  if (context === undefined) return {};
  return {
    requestId: context.requestId,
    correlationId: context.correlationId,
    ...(context.tenantId === undefined ? {} : { tenantId: context.tenantId }),
    ...(context.actor === undefined ? {} : { actor: `${context.actor.type}:${context.actor.id}` }),
  };
}

function wrap(instance: PinoLogger): Logger {
  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    const safe = fields === undefined ? {} : (redactForLog(fields) as Record<string, unknown>);
    instance[level](safe, message);
  };
  return {
    debug: (message, fields) => {
      emit('debug', message, fields);
    },
    info: (message, fields) => {
      emit('info', message, fields);
    },
    warn: (message, fields) => {
      emit('warn', message, fields);
    },
    error: (message, fields) => {
      emit('error', message, fields);
    },
    child: (bindings) => wrap(instance.child(redactForLog(bindings) as Record<string, unknown>)),
  };
}
