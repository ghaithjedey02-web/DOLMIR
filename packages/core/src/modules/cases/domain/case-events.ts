import { z } from 'zod';

import { PolicyLevelSchema } from '../../../kernel/action-policy.js';
import { EpistemicStatusSchema, EvidenceSchema } from '../../../kernel/epistemic.js';
import { CaseIdSchema, UserIdSchema, UuidSchema } from '../../../kernel/ids.js';
import { NonDeterminatoSchema } from '../../../kernel/non-determinato.js';
import {
  CaseDeterminationSchema,
  CaseKindSchema,
  CasePrioritySchema,
  SubjectRefSchema,
  SystemKeySchema,
} from './case.js';

/**
 * The events of a case stream (`case/<id>`), each with its payload schema.
 * The projection validates payloads on apply, so a corrupt or unknown event
 * is a loud error, never a silently wrong read model.
 */
export const CASE_STREAM_TYPE = 'case';

export const CaseEventType = {
  OPENED: 'CaseOpened',
  FINDING_RECORDED: 'FindingRecorded',
  RECOMMENDATION_PROPOSED: 'RecommendationProposed',
  RECOMMENDATION_APPROVED: 'RecommendationApproved',
  RECOMMENDATION_REJECTED: 'RecommendationRejected',
  ACTION_EXECUTED: 'ActionExecuted',
  ACTION_FAILED: 'ActionFailed',
  RESOLVED: 'CaseResolved',
  OUTCOME_RECORDED: 'OutcomeRecorded',
} as const;
export type CaseEventType = (typeof CaseEventType)[keyof typeof CaseEventType];

export const CaseOpenedPayload = z
  .object({
    caseId: CaseIdSchema,
    systemKey: SystemKeySchema,
    systemVersion: z.number().int().min(1),
    kind: CaseKindSchema,
    title: z.string(),
    summary: z.string(),
    priority: CasePrioritySchema,
    determination: CaseDeterminationSchema,
    nonDeterminato: NonDeterminatoSchema.nullable(),
    subjects: z.array(SubjectRefSchema),
  })
  .strict();

export const FindingRecordedPayload = z
  .object({
    findingId: UuidSchema,
    statement: z.string(),
    status: EpistemicStatusSchema,
    evidence: z.array(EvidenceSchema),
    tags: z.array(z.string()),
  })
  .strict();

export const RecommendationProposedPayload = z
  .object({
    recommendationId: UuidSchema,
    tool: z.string(),
    input: z.unknown(),
    inputHash: z.string(),
    rationale: z.string(),
    level: PolicyLevelSchema,
    policyVersion: z.number().int().min(0),
  })
  .strict();

export const RecommendationDecidedPayload = z
  .object({
    recommendationId: UuidSchema,
    approvalId: UuidSchema,
    decidedBy: UserIdSchema,
    note: z.string().nullable(),
  })
  .strict();

export const ActionExecutedPayload = z
  .object({
    actionId: UuidSchema,
    recommendationId: UuidSchema,
    tool: z.string(),
    inputHash: z.string(),
    result: z.unknown(),
  })
  .strict();

export const ActionFailedPayload = z
  .object({
    actionId: UuidSchema,
    recommendationId: UuidSchema,
    tool: z.string(),
    inputHash: z.string(),
    error: z.record(z.string(), z.unknown()),
  })
  .strict();

export const CaseResolvedPayload = z
  .object({
    resolution: z.string().min(1).max(100),
    note: z.string().nullable(),
  })
  .strict();

export const OutcomeRecordedPayload = z
  .object({
    kind: z.string().regex(/^[a-z][a-z0-9_]*$/),
    details: z.record(z.string(), z.unknown()),
  })
  .strict();

export const CaseResolution = {
  ACTIONED: 'actioned',
  DISMISSED: 'dismissed',
  RESOLVED_MANUALLY: 'resolved_manually',
} as const;
