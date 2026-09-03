import { z } from 'zod';

import type { Clock } from '../../../kernel/clock.js';
import { ClaimSchema } from '../../../kernel/epistemic.js';
import { UuidSchema, newUuid } from '../../../kernel/ids.js';
import { HumanDecisionRequestSchema } from '../../../kernel/non-determinato.js';
import { ok } from '../../../kernel/result.js';
import { Permission } from '../../../modules/access/index.js';
import { type ToolDefinition, defineTool } from '../define-tool.js';
import { ToolEffect } from '../policy.js';

/**
 * The human gate as a tool (Directive §15, ADR-0011): the model may *ask* for
 * a decision, with the claims and evidence the question rests on; it can never
 * take the decision (`decisions:approve` is human-only). In Phase 0 the
 * request is a value the caller routes to a person; the persisted approvals
 * table arrives with the first workflow and this tool's output is what it
 * will store.
 */
export const RequestHumanDecisionInputSchema = HumanDecisionRequestSchema.extend({
  /** What the decision is about, in the tenant's own terms. */
  subject: z.string().trim().min(1),
  /** The claims the question rests on — each with its epistemic status and evidence. */
  basis: z.array(ClaimSchema).default([]),
  urgency: z.enum(['low', 'normal', 'high']).default('normal'),
});
export type RequestHumanDecisionInput = z.infer<typeof RequestHumanDecisionInputSchema>;

export const HumanDecisionRequestedSchema = RequestHumanDecisionInputSchema.extend({
  kind: z.literal('HUMAN_DECISION_REQUESTED'),
  id: UuidSchema,
  status: z.literal('pending'),
  requestedAt: z.iso.datetime(),
});
export type HumanDecisionRequested = z.infer<typeof HumanDecisionRequestedSchema>;

export const REQUEST_HUMAN_DECISION = 'request_human_decision';

export function createRequestHumanDecisionTool(
  clock: Clock,
): ToolDefinition<RequestHumanDecisionInput, HumanDecisionRequested> {
  return defineTool({
    name: REQUEST_HUMAN_DECISION,
    description:
      'Ask a human to decide. Use it whenever an action has consequences (money, delivery, a commitment to a customer or supplier), whenever policy requires approval, or whenever the evidence supports more than one reasonable course. Give the question, the options, what is at stake and the claims the question rests on.',
    effect: ToolEffect.DRAFT,
    permission: Permission.AI_INVOKE,
    input: RequestHumanDecisionInputSchema,
    output: HumanDecisionRequestedSchema,
    handler: async (input) =>
      ok(
        HumanDecisionRequestedSchema.parse({
          ...input,
          kind: 'HUMAN_DECISION_REQUESTED',
          id: newUuid(),
          status: 'pending',
          requestedAt: clock.now().toISOString(),
        }),
      ),
  });
}
