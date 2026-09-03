import { z } from 'zod';

import { translatePgError } from '../../../../infrastructure/postgres/errors.js';
import { clientOf } from '../../../../infrastructure/postgres/transaction-runner.js';
import { PolicyLevelSchema } from '../../../../kernel/action-policy.js';
import { EpistemicStatusSchema, EvidenceSchema } from '../../../../kernel/epistemic.js';
import { InternalError, validationErrorFromZod } from '../../../../kernel/errors.js';
import {
  CaseIdSchema,
  type CaseId,
  type DocumentId,
  OrganizationIdSchema,
  UserIdSchema,
  UuidSchema,
} from '../../../../kernel/ids.js';
import { NonDeterminatoSchema } from '../../../../kernel/non-determinato.js';
import type { Scope, TenantScope } from '../../../../kernel/scope.js';
import type { CaseQuery, CaseRepository } from '../../application/ports.js';
import {
  type ActionRecord,
  ActionRecordSchema,
  ActionStatusSchema,
  type Approval,
  ApprovalDecisionSchema,
  ApprovalSchema,
  type Case,
  CaseDeterminationSchema,
  CasePrioritySchema,
  CaseSchema,
  CaseStatusSchema,
  type Finding,
  FindingSchema,
  type Recommendation,
  RecommendationSchema,
  RecommendationStatusSchema,
  SubjectRefSchema,
} from '../../domain/case.js';

function parseRow<S extends z.ZodType>(schema: S, raw: unknown, table: string): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new InternalError('ROW_SHAPE_MISMATCH', `A row of ${table} did not match its schema.`, {
      cause: validationErrorFromZod(parsed.error),
    });
  }
  return parsed.data;
}

const CaseRow = z.object({
  id: CaseIdSchema,
  organization_id: OrganizationIdSchema,
  system_key: z.string(),
  system_version: z.number().int(),
  kind: z.string(),
  status: CaseStatusSchema,
  priority: CasePrioritySchema,
  title: z.string(),
  summary: z.string(),
  determination: CaseDeterminationSchema,
  non_determinato: NonDeterminatoSchema.nullable(),
  subjects: z.array(SubjectRefSchema),
  version: z.number().int(),
  opened_at: z.date(),
  updated_at: z.date(),
  resolved_at: z.date().nullable(),
  resolution: z.string().nullable(),
});

const FindingRow = z.object({
  id: UuidSchema,
  organization_id: OrganizationIdSchema,
  case_id: CaseIdSchema,
  statement: z.string(),
  status: EpistemicStatusSchema,
  evidence: z.array(EvidenceSchema),
  tags: z.array(z.string()),
  created_at: z.date(),
});

const RecommendationRow = z.object({
  id: UuidSchema,
  organization_id: OrganizationIdSchema,
  case_id: CaseIdSchema,
  tool: z.string(),
  input: z.unknown(),
  input_hash: z.string(),
  rationale: z.string(),
  level: PolicyLevelSchema,
  policy_version: z.number().int(),
  status: RecommendationStatusSchema,
  created_at: z.date(),
  decided_at: z.date().nullable(),
  decided_by: UserIdSchema.nullable(),
  decision_note: z.string().nullable(),
  executed_at: z.date().nullable(),
});

const ApprovalRow = z.object({
  id: UuidSchema,
  organization_id: OrganizationIdSchema,
  case_id: CaseIdSchema,
  recommendation_id: UuidSchema,
  decision: ApprovalDecisionSchema,
  decided_by: UserIdSchema,
  note: z.string().nullable(),
  decided_at: z.date(),
});

const ActionRow = z.object({
  id: UuidSchema,
  organization_id: OrganizationIdSchema,
  case_id: CaseIdSchema,
  recommendation_id: UuidSchema,
  tool: z.string(),
  input_hash: z.string(),
  status: ActionStatusSchema,
  result: z.unknown(),
  error: z.record(z.string(), z.unknown()).nullable(),
  executed_at: z.date(),
});

const CASE_COLUMNS =
  'id, organization_id, system_key, system_version, kind, status, priority, title, summary, determination, non_determinato, subjects, version, opened_at, updated_at, resolved_at, resolution';
const FINDING_COLUMNS =
  'id, organization_id, case_id, statement, status, evidence, tags, created_at';
const RECOMMENDATION_COLUMNS =
  'id, organization_id, case_id, tool, input, input_hash, rationale, level, policy_version, status, created_at, decided_at, decided_by, decision_note, executed_at';
const APPROVAL_COLUMNS =
  'id, organization_id, case_id, recommendation_id, decision, decided_by, note, decided_at';
const ACTION_COLUMNS =
  'id, organization_id, case_id, recommendation_id, tool, input_hash, status, result, error, executed_at';

const toCase = (raw: unknown): Case => {
  const row = parseRow(CaseRow, raw, 'cases');
  return CaseSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    systemKey: row.system_key,
    systemVersion: row.system_version,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    title: row.title,
    summary: row.summary,
    determination: row.determination,
    nonDeterminato: row.non_determinato,
    subjects: row.subjects,
    version: row.version,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
  });
};

const toFinding = (raw: unknown): Finding => {
  const row = parseRow(FindingRow, raw, 'case_findings');
  return FindingSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    caseId: row.case_id,
    statement: row.statement,
    status: row.status,
    evidence: row.evidence,
    tags: row.tags,
    createdAt: row.created_at,
  });
};

const toRecommendation = (raw: unknown): Recommendation => {
  const row = parseRow(RecommendationRow, raw, 'recommendations');
  return RecommendationSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    caseId: row.case_id,
    tool: row.tool,
    input: row.input,
    inputHash: row.input_hash,
    rationale: row.rationale,
    level: row.level,
    policyVersion: row.policy_version,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decisionNote: row.decision_note,
    executedAt: row.executed_at,
  });
};

const toApproval = (raw: unknown): Approval => {
  const row = parseRow(ApprovalRow, raw, 'approvals');
  return ApprovalSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    caseId: row.case_id,
    recommendationId: row.recommendation_id,
    decision: row.decision,
    decidedBy: row.decided_by,
    note: row.note,
    decidedAt: row.decided_at,
  });
};

const toAction = (raw: unknown): ActionRecord => {
  const row = parseRow(ActionRow, raw, 'actions');
  return ActionRecordSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    caseId: row.case_id,
    recommendationId: row.recommendation_id,
    tool: row.tool,
    inputHash: row.input_hash,
    status: row.status,
    result: row.result,
    error: row.error,
    executedAt: row.executed_at,
  });
};

const json = (value: unknown): string => JSON.stringify(value ?? null);

export class PostgresCaseRepository implements CaseRepository {
  async upsertCase(scope: Scope, item: Case): Promise<void> {
    try {
      await clientOf(scope).query(
        `INSERT INTO public.cases
           (id, organization_id, system_key, system_version, kind, status, priority, title, summary, determination,
            non_determinato, subjects, version, opened_at, updated_at, resolved_at, resolution)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status, priority = EXCLUDED.priority, title = EXCLUDED.title, summary = EXCLUDED.summary,
           determination = EXCLUDED.determination, non_determinato = EXCLUDED.non_determinato, subjects = EXCLUDED.subjects,
           version = EXCLUDED.version, updated_at = EXCLUDED.updated_at, resolved_at = EXCLUDED.resolved_at,
           resolution = EXCLUDED.resolution`,
        [
          item.id,
          item.organizationId,
          item.systemKey,
          item.systemVersion,
          item.kind,
          item.status,
          item.priority,
          item.title,
          item.summary,
          item.determination,
          json(item.nonDeterminato),
          json(item.subjects),
          item.version,
          item.openedAt,
          item.updatedAt,
          item.resolvedAt,
          item.resolution,
        ],
      );
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async findCase(scope: Scope, id: CaseId): Promise<Case | undefined> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${CASE_COLUMNS} FROM public.cases WHERE id = $1`,
        [id],
      );
      const row: unknown = result.rows[0];
      return row === undefined ? undefined : toCase(row);
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async findCasesForDocument(
    scope: Scope,
    documentId: DocumentId,
    systemKey: string,
  ): Promise<Case[]> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${CASE_COLUMNS} FROM public.cases
          WHERE system_key = $1 AND subjects @> $2::jsonb
          ORDER BY opened_at`,
        [systemKey, JSON.stringify([{ type: 'document', id: documentId }])],
      );
      return result.rows.map((row: unknown) => toCase(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async listCases(scope: TenantScope, query: CaseQuery): Promise<Case[]> {
    const values: unknown[] = [scope.tenantId, Math.min(Math.max(query.limit, 1), 500)];
    const conditions = ['organization_id = $1'];
    if (query.statuses !== undefined && query.statuses.length > 0) {
      values.push([...query.statuses]);
      conditions.push(`status = ANY($${values.length}::text[])`);
    }
    if (query.systemKey !== undefined) {
      values.push(query.systemKey);
      conditions.push(`system_key = $${values.length}`);
    }
    if (query.kind !== undefined) {
      values.push(query.kind);
      conditions.push(`kind = $${values.length}`);
    }
    if (query.before !== undefined) {
      values.push(query.before);
      conditions.push(`opened_at < $${values.length}`);
    }
    try {
      const result = await clientOf(scope).query(
        `SELECT ${CASE_COLUMNS} FROM public.cases
          WHERE ${conditions.join(' AND ')}
          ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, opened_at DESC
          LIMIT $2`,
        values,
      );
      return result.rows.map((row: unknown) => toCase(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async insertFinding(scope: Scope, finding: Finding): Promise<void> {
    try {
      await clientOf(scope).query(
        `INSERT INTO public.case_findings (id, organization_id, case_id, statement, status, evidence, tags, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::text[], $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          finding.id,
          finding.organizationId,
          finding.caseId,
          finding.statement,
          finding.status,
          json(finding.evidence),
          finding.tags,
          finding.createdAt,
        ],
      );
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async listFindings(scope: Scope, caseId: CaseId): Promise<Finding[]> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${FINDING_COLUMNS} FROM public.case_findings WHERE case_id = $1 ORDER BY created_at, id`,
        [caseId],
      );
      return result.rows.map((row: unknown) => toFinding(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async upsertRecommendation(scope: Scope, recommendation: Recommendation): Promise<void> {
    try {
      await clientOf(scope).query(
        `INSERT INTO public.recommendations
           (id, organization_id, case_id, tool, input, input_hash, rationale, level, policy_version, status,
            created_at, decided_at, decided_by, decision_note, executed_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status, decided_at = EXCLUDED.decided_at, decided_by = EXCLUDED.decided_by,
           decision_note = EXCLUDED.decision_note, executed_at = EXCLUDED.executed_at`,
        [
          recommendation.id,
          recommendation.organizationId,
          recommendation.caseId,
          recommendation.tool,
          json(recommendation.input),
          recommendation.inputHash,
          recommendation.rationale,
          recommendation.level,
          recommendation.policyVersion,
          recommendation.status,
          recommendation.createdAt,
          recommendation.decidedAt,
          recommendation.decidedBy,
          recommendation.decisionNote,
          recommendation.executedAt,
        ],
      );
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async findRecommendation(scope: Scope, id: string): Promise<Recommendation | undefined> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${RECOMMENDATION_COLUMNS} FROM public.recommendations WHERE id = $1`,
        [id],
      );
      const row: unknown = result.rows[0];
      return row === undefined ? undefined : toRecommendation(row);
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async listRecommendations(scope: Scope, caseId: CaseId): Promise<Recommendation[]> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${RECOMMENDATION_COLUMNS} FROM public.recommendations WHERE case_id = $1 ORDER BY created_at, id`,
        [caseId],
      );
      return result.rows.map((row: unknown) => toRecommendation(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async insertApproval(scope: Scope, approval: Approval): Promise<void> {
    try {
      await clientOf(scope).query(
        `INSERT INTO public.approvals (id, organization_id, case_id, recommendation_id, decision, decided_by, note, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [
          approval.id,
          approval.organizationId,
          approval.caseId,
          approval.recommendationId,
          approval.decision,
          approval.decidedBy,
          approval.note,
          approval.decidedAt,
        ],
      );
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async listApprovals(scope: Scope, caseId: CaseId): Promise<Approval[]> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${APPROVAL_COLUMNS} FROM public.approvals WHERE case_id = $1 ORDER BY decided_at, id`,
        [caseId],
      );
      return result.rows.map((row: unknown) => toApproval(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async insertAction(scope: Scope, action: ActionRecord): Promise<void> {
    try {
      await clientOf(scope).query(
        `INSERT INTO public.actions (id, organization_id, case_id, recommendation_id, tool, input_hash, status, result, error, executed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10) ON CONFLICT (id) DO NOTHING`,
        [
          action.id,
          action.organizationId,
          action.caseId,
          action.recommendationId,
          action.tool,
          action.inputHash,
          action.status,
          json(action.result),
          json(action.error),
          action.executedAt,
        ],
      );
    } catch (error) {
      throw translatePgError(error);
    }
  }

  async listActions(scope: Scope, caseId: CaseId): Promise<ActionRecord[]> {
    try {
      const result = await clientOf(scope).query(
        `SELECT ${ACTION_COLUMNS} FROM public.actions WHERE case_id = $1 ORDER BY executed_at, id`,
        [caseId],
      );
      return result.rows.map((row: unknown) => toAction(row));
    } catch (error) {
      throw translatePgError(error);
    }
  }

  /** Rebuild support: requires the owner role (the runtime role has no DELETE). */
  async reset(scope: Scope): Promise<void> {
    try {
      const client = clientOf(scope);
      for (const table of ['actions', 'approvals', 'recommendations', 'case_findings', 'cases']) {
        await client.query(`DELETE FROM public.${table}`);
      }
    } catch (error) {
      throw translatePgError(error);
    }
  }
}
