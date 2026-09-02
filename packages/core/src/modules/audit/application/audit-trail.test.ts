import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../../kernel/clock.js';
import {
  ActorType,
  type ExecutionContextProvider,
  noExecutionContext,
} from '../../../kernel/context.js';
import { newCorrelationId, newOrganizationId, newRequestId } from '../../../kernel/ids.js';
import type { TenantScope } from '../../../kernel/scope.js';
import { InMemoryAuditLogRepository } from '../adapters/memory/in-memory-audit-log-repository.js';
import { AuditTrail } from './audit-trail.js';

const clock = new FixedClock(new Date('2026-09-02T12:00:00.000Z'));
const tenantId = newOrganizationId();
const scope: TenantScope = { kind: 'tenant', tenantId };

describe('AuditTrail', () => {
  it('stamps id, time and request context, blanks secret keys but keeps business text', async () => {
    const repository = new InMemoryAuditLogRepository();
    const requestId = newRequestId();
    const correlationId = newCorrelationId();
    const context: ExecutionContextProvider = { current: () => ({ requestId, correlationId }) };
    const trail = new AuditTrail({ repository, clock, context });

    const entry = await trail.record(scope, {
      organizationId: tenantId,
      actor: { type: ActorType.USER, id: 'user-1' },
      action: 'member.invited',
      target: { type: 'user', id: 'user-2' },
      details: { email: 'rossi@example.test', apiKey: 'sk-secret', nested: { password: 'pw' } },
    });

    expect(entry).toMatchObject({
      organizationId: tenantId,
      action: 'member.invited',
      outcome: 'success',
      requestId,
      correlationId,
      occurredAt: clock.now(),
      details: {
        email: 'rossi@example.test',
        apiKey: '[REDACTED]',
        nested: { password: '[REDACTED]' },
      },
    });
    expect(repository.entries).toHaveLength(1);
    expect(await trail.list(scope, { limit: 10 })).toEqual([entry]);
  });

  it('refuses malformed actions and applies defaults', async () => {
    const trail = new AuditTrail({
      repository: new InMemoryAuditLogRepository(),
      clock,
      context: noExecutionContext,
    });
    await expect(
      trail.record(scope, {
        organizationId: tenantId,
        actor: { type: ActorType.SYSTEM, id: 'x' },
        action: 'Invited',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_AUDIT_ENTRY' });

    const entry = await trail.record(scope, {
      organizationId: tenantId,
      actor: { type: ActorType.SYSTEM, id: 'scheduler' },
      action: 'projection.rebuilt',
    });
    expect(entry).toMatchObject({
      target: null,
      outcome: 'success',
      details: {},
      requestId: null,
      correlationId: null,
    });
  });

  it('lists a tenant’s entries newest first with filters', async () => {
    const repository = new InMemoryAuditLogRepository();
    const trail = new AuditTrail({ repository, clock, context: noExecutionContext });
    const actor = { type: ActorType.USER, id: 'u' };
    await trail.record(scope, { organizationId: tenantId, actor, action: 'a.first' });
    clock.advance(1000);
    await trail.record(scope, { organizationId: tenantId, actor, action: 'b.second' });
    clock.advance(1000);
    await trail.record(scope, { organizationId: tenantId, actor, action: 'a.first' });

    const all = await trail.list(scope, { limit: 10 });
    expect(all.map((e) => e.action)).toEqual(['a.first', 'b.second', 'a.first']);
    expect((await trail.list(scope, { limit: 10, action: 'a.first' })).length).toBe(2);
    expect((await trail.list(scope, { limit: 1 })).length).toBe(1);
    expect(
      (await trail.list({ kind: 'tenant', tenantId: newOrganizationId() }, { limit: 10 })).length,
    ).toBe(0);
  });
});
