import { z } from 'zod';

import { PolicyLevelSchema } from '../../../kernel/action-policy.js';
import { ClaimSchema, EpistemicStatusSchema, EvidenceSchema } from '../../../kernel/epistemic.js';
import { type DomainErrorRecord } from '../../../kernel/errors.js';
import {
  CaseIdSchema,
  OrganizationIdSchema,
  UserIdSchema,
  UuidSchema,
} from '../../../kernel/ids.js';
import { NonDeterminatoSchema } from '../../../kernel/non-determinato.js';

/**
 * A case is a unit of attention (ADR-0012 §3): what an AI System found, with
 * evidence, what it recommends, what a human decided, what was done and what
 * came of it. Generic across systems; the system contributes `kind`, the
 * findings and the recommendations. State is a projection of ledger events.
 */
export const CaseStatus = {
  OPEN: 'open',
  AWAITING_APPROVAL: 'awaiting_approval',
  RESOLVED: 'resolved',
  DISMISSED: 'dismissed',
} as const;
export const CaseStatusSchema = z.enum(['open', 'awaiting_approval', 'resolved', 'dismissed']);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

export const CasePrioritySchema = z.enum(['low', 'normal', 'high']);
export type CasePriority = z.infer<typeof CasePrioritySchema>;

/** Whether the system could reach a reviewable conclusion (ADR-0007). */
export const CaseDeterminationSchema = z.enum([
  'READY_FOR_REVIEW',
  'NON_DETERMINATO',
  'NOT_APPLICABLE',
]);
export type CaseDetermination = z.infer<typeof CaseDeterminationSchema>;

/** What the case is about: documents, entities, later records of other systems. */
export const SubjectRefSchema = z
  .object({
    type: z.string().regex(/^[a-z][a-z0-9_]*$/),
    id: z.string().trim().min(1).max(255),
    label: z.string().trim().min(1).max(300).optional(),
  })
  .strict();
export type SubjectRef = z.infer<typeof SubjectRefSchema>;

export const CaseKindSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, 'snake_case');
export const SystemKeySchema = z.string().regex(/^[a-z][a-z0-9_]*$/, 'snake_case');

export const CaseSchema = z
  .object({
    id: CaseIdSchema,
    organizationId: OrganizationIdSchema,
    systemKey: SystemKeySchema,
    systemVersion: z.number().int().min(1),
    kind: CaseKindSchema,
    status: CaseStatusSchema,
    priority: CasePrioritySchema,
    title: z.string().trim().min(1).max(300),
    summary: z.string().trim().min(1).max(4000),
    determination: CaseDeterminationSchema,
    nonDeterminato: NonDeterminatoSchema.nullable(),
    subjects: z.array(SubjectRefSchema),
    /** The ledger stream version after the last applied event. */
    version: z.number().int().min(1),
    openedAt: z.date(),
    updatedAt: z.date(),
    resolvedAt: z.date().nullable(),
    resolution: z.string().trim().min(1).max(100).nullable(),
  })
  .strict();
export type Case = z.infer<typeof CaseSchema>;

export const FindingSchema = z
  .object({
    id: UuidSchema,
    organizationId: OrganizationIdSchema,
    caseId: CaseIdSchema,
    statement: z.string().trim().min(1).max(2000),
    status: EpistemicStatusSchema,
    evidence: z.array(EvidenceSchema),
    tags: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).max(20),
    createdAt: z.date(),
  })
  .strict();
export type Finding = z.infer<typeof FindingSchema>;

export const RecommendationStatusSchema = z.enum([
  'proposed',
  'approved',
  'rejected',
  'executed',
  'failed',
  'superseded',
]);
export type RecommendationStatus = z.infer<typeof RecommendationStatusSchema>;

export const RecommendationSchema = z
  .object({
    id: UuidSchema,
    organizationId: OrganizationIdSchema,
    caseId: CaseIdSchema,
    /** The tool that would carry it out — validated against the registry when proposed. */
    tool: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    input: z.unknown(),
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
    rationale: z.string().trim().min(1).max(4000),
    level: PolicyLevelSchema,
    policyVersion: z.number().int().min(0),
    status: RecommendationStatusSchema,
    createdAt: z.date(),
    decidedAt: z.date().nullable(),
    decidedBy: UserIdSchema.nullable(),
    decisionNote: z.string().trim().min(1).max(2000).nullable(),
    executedAt: z.date().nullable(),
  })
  .strict();
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const ApprovalDecisionSchema = z.enum(['approved', 'rejected']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/** A human decision on a recommendation. Append-only. */
export const ApprovalSchema = z
  .object({
    id: UuidSchema,
    organizationId: OrganizationIdSchema,
    caseId: CaseIdSchema,
    recommendationId: UuidSchema,
    decision: ApprovalDecisionSchema,
    decidedBy: UserIdSchema,
    note: z.string().trim().min(1).max(2000).nullable(),
    decidedAt: z.date(),
  })
  .strict();
export type Approval = z.infer<typeof ApprovalSchema>;

export const ActionStatusSchema = z.enum(['succeeded', 'failed']);

/** One execution of a recommendation through the tool executor. Append-only. */
export const ActionRecordSchema = z
  .object({
    id: UuidSchema,
    organizationId: OrganizationIdSchema,
    caseId: CaseIdSchema,
    recommendationId: UuidSchema,
    tool: z.string(),
    inputHash: z.string(),
    status: ActionStatusSchema,
    result: z.unknown(),
    error: z.record(z.string(), z.unknown()).nullable(),
    executedAt: z.date(),
  })
  .strict();
export type ActionRecord = z.infer<typeof ActionRecordSchema>;
export type ActionError = DomainErrorRecord;

/** What an AI System returns: declarative, validated by Core before anything is stored (ADR-0012 §2). */
export const CaseDraftSchema = z
  .object({
    kind: CaseKindSchema,
    title: z.string().trim().min(1).max(300),
    summary: z.string().trim().min(1).max(4000),
    priority: CasePrioritySchema.default('normal'),
    determination: CaseDeterminationSchema,
    nonDeterminato: NonDeterminatoSchema.optional(),
    subjects: z.array(SubjectRefSchema).default([]),
    findings: z
      .array(
        ClaimSchema.and(
          z.object({
            tags: z
              .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
              .max(20)
              .default([]),
          }),
        ),
      )
      .default([]),
    recommendations: z
      .array(
        z
          .object({
            tool: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
            input: z.unknown(),
            rationale: z.string().trim().min(1).max(4000),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .superRefine((draft, ctx) => {
    if (draft.determination === 'NON_DETERMINATO' && draft.nonDeterminato === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['nonDeterminato'],
        message: 'a NON_DETERMINATO case must carry the NON_DETERMINATO account',
      });
    }
  });
export type CaseDraft = z.infer<typeof CaseDraftSchema>;
export type CaseDraftInput = z.input<typeof CaseDraftSchema>;
