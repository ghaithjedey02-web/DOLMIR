import { describe, expect, it } from 'vitest';

import { ActorType } from '../../kernel/context.js';
import { newOrganizationId } from '../../kernel/ids.js';
import { currentContext, newExecutionContext, requireContext, runWithContext } from './index.js';

describe('execution context', () => {
  it('is absent outside a run and present inside, across awaits', async () => {
    expect(currentContext()).toBeUndefined();
    expect(() => requireContext()).toThrow(/runWithContext/);

    const tenantId = newOrganizationId();
    const context = newExecutionContext({ tenantId, actor: { type: ActorType.USER, id: 'u1' } });

    const observed = await runWithContext(context, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentContext();
    });
    expect(observed).toEqual(context);
    expect(observed?.tenantId).toBe(tenantId);
    expect(currentContext()).toBeUndefined();
  });

  it('nests: an inner run shadows the outer one and restores it afterwards', () => {
    const outer = newExecutionContext();
    const inner = newExecutionContext({ correlationId: outer.correlationId });
    runWithContext(outer, () => {
      expect(requireContext().requestId).toBe(outer.requestId);
      runWithContext(inner, () => {
        expect(requireContext().requestId).toBe(inner.requestId);
        expect(requireContext().correlationId).toBe(outer.correlationId);
      });
      expect(requireContext().requestId).toBe(outer.requestId);
    });
  });

  it('omits optional fields instead of writing undefined', () => {
    const context = newExecutionContext();
    expect(Object.keys(context).sort()).toEqual(['correlationId', 'requestId']);
  });
});
