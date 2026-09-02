import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { ActorType } from '../../kernel/context.js';
import { newOrganizationId } from '../../kernel/ids.js';
import { newExecutionContext, runWithContext } from '../context/index.js';
import { createPinoLogger } from './index.js';

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('pino logger', () => {
  it('emits JSON with level, message, timestamp and static bindings', () => {
    const { stream, lines } = capture();
    const logger = createPinoLogger({
      level: 'info',
      format: 'json',
      base: { service: 'test' },
      destination: stream,
    });
    logger.info('booted', { port: 3000 });
    logger.debug('hidden below level');
    const [record] = lines();
    expect(record).toMatchObject({ level: 'info', message: 'booted', port: 3000, service: 'test' });
    expect(typeof record?.['time']).toBe('string');
    expect(lines()).toHaveLength(1);
  });

  it('redacts secrets and personal data in fields and bindings', () => {
    const { stream, lines } = capture();
    const logger = createPinoLogger({ level: 'debug', format: 'json', destination: stream });
    logger.child({ apiKey: 'sk-ant-123', component: 'ai' }).warn('call failed', {
      headers: { authorization: 'Bearer abc', accept: 'json' },
      customer: 'Contattare rossi@example.com al 348 1234567',
      nested: { password: 'pw' },
    });
    const [record] = lines();
    const rendered = JSON.stringify(record);
    expect(rendered).not.toContain('sk-ant-123');
    expect(rendered).not.toContain('Bearer abc');
    expect(rendered).not.toContain('rossi@example.com');
    expect(rendered).not.toContain('1234567');
    expect(rendered).not.toContain('"pw"');
    expect(record).toMatchObject({ component: 'ai', headers: { accept: 'json' } });
  });

  it('mixes the execution context into every line', () => {
    const { stream, lines } = capture();
    const logger = createPinoLogger({ level: 'info', format: 'json', destination: stream });
    const tenantId = newOrganizationId();
    const context = newExecutionContext({ tenantId, actor: { type: ActorType.USER, id: 'u-1' } });
    runWithContext(context, () => {
      logger.info('inside');
    });
    logger.info('outside');
    const [inside, outside] = lines();
    expect(inside).toMatchObject({
      requestId: context.requestId,
      correlationId: context.correlationId,
      tenantId,
      actor: 'USER:u-1',
    });
    expect(outside).not.toHaveProperty('requestId');
  });
});
