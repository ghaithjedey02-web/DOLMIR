import type { z } from 'zod';

import { InternalError } from '../../../kernel/errors.js';
import { CaseIdSchema } from '../../../kernel/ids.js';
import type { Scope, SystemScope } from '../../../kernel/scope.js';
import type { LedgerEvent, Projection } from '../../ledger/index.js';
import {
  ActionRecordSchema,
  ApprovalSchema,
  type Case,
  CaseSchema,
  FindingSchema,
  type Recommendation,
  RecommendationSchema,
} from '../domain/case.js';
import {
  ActionExecutedPayload,
  ActionFailedPayload,
  CASE_STREAM_TYPE,
  CaseEventType,
  CaseOpenedPayload,
  CaseResolvedPayload,
  FindingRecordedPayload,
  OutcomeRecordedPayload,
  RecommendationDecidedPayload,
  RecommendationProposedPayload,
} from '../domain/case-events.js';
import type { CaseRepository } from './ports.js';

/**
 * Derives the case read model from case events (ADR-0004, ADR-0012 §3). The
 * engine applies it synchronously in the transaction that appends the
 * events; `ProjectionRunner.rebuild` replays the whole ledger through it.
 */
export class CaseProjection implements Projection {
  readonly name = 'cases';
  private readonly repository: CaseRepository;

  constructor(repository: CaseRepository) {
    this.repository = repository;
  }

  async apply(scope: Scope, event: LedgerEvent): Promise<void> {
    if (event.stream.type !== CASE_STREAM_TYPE) return;
    const caseId = CaseIdSchema.parse(event.stream.id);
    switch (event.eventType) {
      case CaseEventType.OPENED: {
        const payload = parse(CaseOpenedPayload, event);
        await this.repository.upsertCase(
          scope,
          CaseSchema.parse({
            id: payload.caseId,
            organizationId: event.organizationId,
            systemKey: payload.systemKey,
            systemVersion: payload.systemVersion,
            kind: payload.kind,
            status: 'open',
            priority: payload.priority,
            title: payload.title,
            summary: payload.summary,
            determination: payload.determination,
            nonDeterminato: payload.nonDeterminato,
            subjects: payload.subjects,
            version: event.streamSequence,
            openedAt: event.occurredAt,
            updatedAt: event.occurredAt,
            resolvedAt: null,
            resolution: null,
          }),
        );
        return;
      }
      case CaseEventType.FINDING_RECORDED: {
        const payload = parse(FindingRecordedPayload, event);
        await this.repository.insertFinding(
          scope,
          FindingSchema.parse({
            id: payload.findingId,
            organizationId: event.organizationId,
            caseId,
            statement: payload.statement,
            status: payload.status,
            evidence: payload.evidence,
            tags: payload.tags,
            createdAt: event.occurredAt,
          }),
        );
        await this.touch(scope, caseId, event);
        return;
      }
      case CaseEventType.RECOMMENDATION_PROPOSED: {
        const payload = parse(RecommendationProposedPayload, event);
        await this.repository.upsertRecommendation(
          scope,
          RecommendationSchema.parse({
            id: payload.recommendationId,
            organizationId: event.organizationId,
            caseId,
            tool: payload.tool,
            input: payload.input,
            inputHash: payload.inputHash,
            rationale: payload.rationale,
            level: payload.level,
            policyVersion: payload.policyVersion,
            status: 'proposed',
            createdAt: event.occurredAt,
            decidedAt: null,
            decidedBy: null,
            decisionNote: null,
            executedAt: null,
          }),
        );
        await this.touch(scope, caseId, event, (current) =>
          payload.level === 'REQUIRE_APPROVAL' && current.status === 'open'
            ? { status: 'awaiting_approval' }
            : {},
        );
        return;
      }
      case CaseEventType.RECOMMENDATION_APPROVED:
      case CaseEventType.RECOMMENDATION_REJECTED: {
        const payload = parse(RecommendationDecidedPayload, event);
        const decision =
          event.eventType === CaseEventType.RECOMMENDATION_APPROVED ? 'approved' : 'rejected';
        const recommendation = await this.require(scope, payload.recommendationId);
        await this.repository.upsertRecommendation(scope, {
          ...recommendation,
          status: decision,
          decidedAt: event.occurredAt,
          decidedBy: payload.decidedBy,
          decisionNote: payload.note,
        });
        await this.repository.insertApproval(
          scope,
          ApprovalSchema.parse({
            id: payload.approvalId,
            organizationId: event.organizationId,
            caseId,
            recommendationId: payload.recommendationId,
            decision,
            decidedBy: payload.decidedBy,
            note: payload.note,
            decidedAt: event.occurredAt,
          }),
        );
        await this.touch(scope, caseId, event);
        return;
      }
      case CaseEventType.ACTION_EXECUTED:
      case CaseEventType.ACTION_FAILED: {
        const succeeded = event.eventType === CaseEventType.ACTION_EXECUTED;
        const payload = succeeded
          ? parse(ActionExecutedPayload, event)
          : parse(ActionFailedPayload, event);
        const recommendation = await this.require(scope, payload.recommendationId);
        await this.repository.upsertRecommendation(scope, {
          ...recommendation,
          status: succeeded ? 'executed' : 'failed',
          executedAt: event.occurredAt,
        });
        await this.repository.insertAction(
          scope,
          ActionRecordSchema.parse({
            id: payload.actionId,
            organizationId: event.organizationId,
            caseId,
            recommendationId: payload.recommendationId,
            tool: payload.tool,
            inputHash: payload.inputHash,
            status: succeeded ? 'succeeded' : 'failed',
            result: 'result' in payload ? payload.result : null,
            error: 'error' in payload ? payload.error : null,
            executedAt: event.occurredAt,
          }),
        );
        await this.touch(scope, caseId, event);
        return;
      }
      case CaseEventType.RESOLVED: {
        const payload = parse(CaseResolvedPayload, event);
        await this.touch(scope, caseId, event, () => ({
          status: payload.resolution === 'dismissed' ? 'dismissed' : 'resolved',
          resolvedAt: event.occurredAt,
          resolution: payload.resolution,
        }));
        return;
      }
      case CaseEventType.OUTCOME_RECORDED: {
        parse(OutcomeRecordedPayload, event);
        await this.touch(scope, caseId, event);
        return;
      }
      default:
        throw new InternalError(
          'UNKNOWN_CASE_EVENT',
          `Unknown case event type "${event.eventType}".`,
          { details: { eventType: event.eventType, caseId } },
        );
    }
  }

  async reset(scope: SystemScope): Promise<void> {
    await this.repository.reset(scope);
  }

  private async touch(
    scope: Scope,
    caseId: Case['id'],
    event: LedgerEvent,
    patch: (current: Case) => Partial<Case> = () => ({}),
  ): Promise<void> {
    const current = await this.repository.findCase(scope, caseId);
    if (current === undefined) {
      throw new InternalError(
        'CASE_NOT_PROJECTED',
        'An event arrived for a case that was never opened.',
        { details: { caseId, eventType: event.eventType } },
      );
    }
    await this.repository.upsertCase(scope, {
      ...current,
      ...patch(current),
      version: event.streamSequence,
      updatedAt: event.occurredAt,
    });
  }

  private async require(scope: Scope, recommendationId: string): Promise<Recommendation> {
    const recommendation = await this.repository.findRecommendation(scope, recommendationId);
    if (recommendation === undefined) {
      throw new InternalError(
        'RECOMMENDATION_NOT_PROJECTED',
        'A decision arrived for an unknown recommendation.',
        { details: { recommendationId } },
      );
    }
    return recommendation;
  }
}

function parse<S extends z.ZodType>(schema: S, event: LedgerEvent): z.output<S> {
  const parsed = schema.safeParse(event.payload);
  if (!parsed.success) {
    throw new InternalError('INVALID_CASE_EVENT', `The payload of ${event.eventType} is invalid.`, {
      details: { eventType: event.eventType, issues: parsed.error.issues.length },
    });
  }
  return parsed.data;
}
