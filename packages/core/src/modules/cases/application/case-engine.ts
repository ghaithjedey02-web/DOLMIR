import { type Actor, ActorType } from '../../../kernel/context.js';
import type { Clock } from '../../../kernel/clock.js';
import {
  type DomainError,
  ForbiddenError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
  validationErrorFromZod,
} from '../../../kernel/errors.js';
import { type CaseId, type OrganizationId, newCaseId, newUuid } from '../../../kernel/ids.js';
import { type Logger, noopLogger } from '../../../kernel/logger.js';
import { err, ok, type Result } from '../../../kernel/result.js';
import type { TenantScope, TransactionRunner } from '../../../kernel/scope.js';
import type { RoleKey, TenantContext } from '../../../kernel/tenant.js';
import {
  type ActionPolicy,
  type ApprovalRef,
  type ToolExecutor,
  type ToolRegistry,
  digestOf,
} from '../../../ai/index.js';
import { type Authorizer, Permission } from '../../access/index.js';
import type { EventLedger, LedgerEvent, NewLedgerEventInput } from '../../ledger/index.js';
import type { MembershipRepository } from '../../tenancy/index.js';
import {
  type ActionRecord,
  type Approval,
  type ApprovalDecision,
  type Case,
  type CaseDraft,
  type CaseDraftInput,
  CaseDraftSchema,
  type Finding,
  type Recommendation,
} from '../domain/case.js';
import { CASE_STREAM_TYPE, CaseEventType, CaseResolution } from '../domain/case-events.js';
import type { CaseProjection } from './case-projection.js';
import type { EvidenceVerifier } from './evidence-verifier.js';
import type { CaseRepository } from './ports.js';

/**
 * The case engine (ADR-0012 §3): turns a system's draft into a case, drives
 * human decisions and executes approved recommendations through the tool
 * executor. Every transition is a ledger event applied to the read model in
 * the same transaction. Nothing here interprets content; that is the system's
 * job. Nothing here bypasses permissions, policy or audit; that is the
 * executor's job.
 */
export interface CaseEngineDependencies {
  readonly transactions: TransactionRunner;
  readonly ledger: EventLedger;
  readonly cases: CaseRepository;
  readonly projection: CaseProjection;
  readonly tools: ToolRegistry;
  readonly policy: ActionPolicy;
  readonly executor: ToolExecutor;
  readonly authorizer: Authorizer;
  /** To run an approved action with the approver's own permissions. */
  readonly memberships: MembershipRepository;
  /**
   * Checks cited document spans before a case is stored. Optional so a
   * deployment can run without it, but every real one wires it: without it a
   * system could store a citation that does not exist.
   */
  readonly evidence?: EvidenceVerifier;
  readonly clock: Clock;
  readonly logger?: Logger;
  /** Role whose permissions AUTO_EXECUTE recommendations run with. Default `operator`. */
  readonly automationRole?: RoleKey;
}

export interface OpenCaseProvenance {
  readonly systemKey: string;
  readonly systemVersion: number;
  /** Where the analysed material came from (the document's source reference). */
  readonly sourceRef: string;
  readonly evidenceRefs?: readonly string[];
}

export interface OpenedCase {
  readonly case: Case;
  readonly findings: readonly Finding[];
  readonly recommendations: readonly Recommendation[];
}

export interface CaseDetail extends OpenedCase {
  readonly approvals: readonly Approval[];
  readonly actions: readonly ActionRecord[];
}

const ENGINE_ACTOR: Actor = { type: ActorType.SYSTEM, id: 'case_engine' };

export class CaseEngine {
  private readonly deps: CaseEngineDependencies;
  private readonly logger: Logger;
  private readonly automationRole: RoleKey;

  constructor(deps: CaseEngineDependencies) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
    this.automationRole = deps.automationRole ?? 'operator';
  }

  /** Validates a draft against the tool registry and the policy, then opens the case. */
  async openCase(
    tenantId: OrganizationId,
    rawDraft: CaseDraftInput,
    provenance: OpenCaseProvenance,
  ): Promise<Result<OpenedCase, DomainError>> {
    const parsed = CaseDraftSchema.safeParse(rawDraft);
    if (!parsed.success) {
      return err(
        validationErrorFromZod(parsed.error, 'INVALID_CASE_DRAFT', 'The case draft is invalid.'),
      );
    }
    const draft = parsed.data;
    const prepared = await this.prepareRecommendations(tenantId, draft);
    if (!prepared.ok) return err(prepared.error);
    const evidence = await this.verifyEvidence(tenantId, draft);
    if (!evidence.ok) return err(evidence.error);

    const caseId = newCaseId();
    const now = this.deps.clock.now();
    const actor: Actor = {
      type: ActorType.AI,
      id: `${provenance.systemKey}@${provenance.systemVersion}`,
    };
    const base = {
      schemaVersion: 1,
      occurredAt: now,
      provenance: {
        sourceKind: 'AI' as const,
        sourceRef: provenance.sourceRef,
        actor,
        evidenceRefs: [...(provenance.evidenceRefs ?? [])],
        recordedBy: 'cases.engine',
      },
    };
    const events: NewLedgerEventInput[] = [
      {
        ...base,
        eventType: CaseEventType.OPENED,
        payload: {
          caseId,
          systemKey: provenance.systemKey,
          systemVersion: provenance.systemVersion,
          kind: draft.kind,
          title: draft.title,
          summary: draft.summary,
          priority: draft.priority,
          determination: draft.determination,
          nonDeterminato: draft.nonDeterminato ?? null,
          subjects: draft.subjects,
        },
      },
      ...draft.findings.map((finding) => ({
        ...base,
        eventType: CaseEventType.FINDING_RECORDED,
        payload: {
          findingId: newUuid(),
          statement: finding.statement,
          status: finding.status,
          evidence: finding.evidence,
          tags: finding.tags,
        },
      })),
      ...prepared.value.map((recommendation) => ({
        ...base,
        eventType: CaseEventType.RECOMMENDATION_PROPOSED,
        payload: recommendation,
      })),
    ];

    return this.deps.transactions.withTenant(tenantId, async (scope) => {
      const appended = await this.deps.ledger.append(
        scope,
        { type: CASE_STREAM_TYPE, id: caseId },
        events,
        'none',
      );
      if (!appended.ok) return err(appended.error);
      await this.applyAll(scope, appended.value);
      const opened = await this.loadOpened(scope, caseId);
      this.logger.info('case opened', {
        caseId,
        systemKey: provenance.systemKey,
        kind: draft.kind,
        determination: draft.determination,
        recommendations: opened.recommendations.length,
      });
      return ok(opened);
    });
  }

  /** A human decides on a recommendation. Human-only permission; the executor runs approved ones separately. */
  async decide(
    tenant: TenantContext,
    recommendationId: string,
    decision: ApprovalDecision,
    note: string | null,
  ): Promise<Result<Recommendation, DomainError>> {
    const permitted = this.deps.authorizer.require(tenant, Permission.DECISIONS_APPROVE);
    if (!permitted.ok) return err(permitted.error);
    return this.deps.transactions.withTenant(tenant.organizationId, async (scope) => {
      const recommendation = await this.deps.cases.findRecommendation(scope, recommendationId);
      if (recommendation === undefined) {
        return err(
          new NotFoundError('RECOMMENDATION_NOT_FOUND', 'The recommendation was not found.'),
        );
      }
      if (recommendation.status !== 'proposed') {
        return err(
          new PreconditionFailedError(
            'RECOMMENDATION_ALREADY_DECIDED',
            'This recommendation was already decided.',
            {
              details: { status: recommendation.status },
            },
          ),
        );
      }
      if (recommendation.level === 'READ_ONLY' || recommendation.level === 'SUGGEST') {
        return err(
          new PreconditionFailedError(
            'RECOMMENDATION_NOT_EXECUTABLE',
            `Policy level ${recommendation.level} does not allow executing this recommendation; it can only be dismissed.`,
          ),
        );
      }
      const current = await this.requireCase(scope, recommendation.caseId);
      const appended = await this.deps.ledger.append(
        scope,
        { type: CASE_STREAM_TYPE, id: current.id },
        [
          {
            eventType:
              decision === 'approved'
                ? CaseEventType.RECOMMENDATION_APPROVED
                : CaseEventType.RECOMMENDATION_REJECTED,
            schemaVersion: 1,
            payload: { recommendationId, approvalId: newUuid(), decidedBy: tenant.userId, note },
            provenance: {
              sourceKind: 'USER',
              sourceRef: `user:${tenant.userId}`,
              actor: { type: ActorType.USER, id: tenant.userId },
              recordedBy: 'cases.engine',
            },
            occurredAt: this.deps.clock.now(),
          },
        ],
        current.version,
      );
      if (!appended.ok) return err(appended.error);
      await this.applyAll(scope, appended.value);
      if (decision === 'rejected') await this.settle(scope, current.id);
      const updated = await this.deps.cases.findRecommendation(scope, recommendationId);
      return updated === undefined
        ? err(new NotFoundError('RECOMMENDATION_NOT_FOUND', 'The recommendation was not found.'))
        : ok(updated);
    });
  }

  /**
   * Executes an approved recommendation (or an AUTO_EXECUTE one) through the
   * tool executor with the approval reference, records the action, and
   * settles the case when nothing is pending.
   */
  async execute(
    tenantId: OrganizationId,
    recommendationId: string,
  ): Promise<Result<ActionRecord, DomainError>> {
    return this.deps.transactions.withTenant(tenantId, async (scope) => {
      const recommendation = await this.deps.cases.findRecommendation(scope, recommendationId);
      if (recommendation === undefined) {
        return err(
          new NotFoundError('RECOMMENDATION_NOT_FOUND', 'The recommendation was not found.'),
        );
      }
      const current = await this.requireCase(scope, recommendation.caseId);
      let approval: ApprovalRef | undefined;
      let tenant: TenantContext;
      if (recommendation.status === 'approved') {
        const approvals = await this.deps.cases.listApprovals(scope, current.id);
        const granted = approvals.find(
          (a) => a.recommendationId === recommendation.id && a.decision === 'approved',
        );
        if (granted === undefined) {
          return err(
            new PreconditionFailedError(
              'APPROVAL_MISSING',
              'No approval record exists for this recommendation.',
            ),
          );
        }
        approval = {
          id: granted.id,
          toolName: recommendation.tool,
          inputHash: recommendation.inputHash,
        };
        tenant = await this.tenantFor(scope, granted.decidedBy);
      } else if (recommendation.status === 'proposed' && recommendation.level === 'AUTO_EXECUTE') {
        tenant = {
          organizationId: tenantId,
          organizationSlug: 'automation',
          userId: ENGINE_USER_ID,
          roleKey: this.automationRole,
        };
      } else {
        return err(
          new PreconditionFailedError(
            'RECOMMENDATION_NOT_EXECUTABLE',
            'Only approved or auto-executable recommendations run.',
            {
              details: { status: recommendation.status, level: recommendation.level },
            },
          ),
        );
      }

      const outcome = await this.deps.executor.execute(
        {
          tenant,
          actor: {
            ...ENGINE_ACTOR,
            ...(approval === undefined ? {} : { onBehalfOf: tenant.userId }),
          },
          scope,
        },
        {
          name: recommendation.tool,
          input: recommendation.input,
          callId: recommendation.id,
          ...(approval === undefined ? {} : { approval }),
        },
      );
      const actionId = newUuid();
      const succeeded = outcome.status === 'ok';
      const appended = await this.deps.ledger.append(
        scope,
        { type: CASE_STREAM_TYPE, id: current.id },
        [
          {
            eventType: succeeded ? CaseEventType.ACTION_EXECUTED : CaseEventType.ACTION_FAILED,
            schemaVersion: 1,
            payload: succeeded
              ? {
                  actionId,
                  recommendationId: recommendation.id,
                  tool: recommendation.tool,
                  inputHash: recommendation.inputHash,
                  result: outcome.output,
                }
              : {
                  actionId,
                  recommendationId: recommendation.id,
                  tool: recommendation.tool,
                  inputHash: recommendation.inputHash,
                  error: outcome.status === 'error' ? outcome.error : { status: outcome.status },
                },
            provenance: {
              sourceKind: 'SYSTEM',
              sourceRef: `recommendation:${recommendation.id}`,
              actor: ENGINE_ACTOR,
              evidenceRefs: approval === undefined ? [] : [`approval:${approval.id}`],
              recordedBy: 'cases.engine',
            },
            occurredAt: this.deps.clock.now(),
          },
          ...(succeeded
            ? [
                {
                  eventType: CaseEventType.OUTCOME_RECORDED,
                  schemaVersion: 1,
                  payload: {
                    kind: 'action_executed',
                    details: { tool: recommendation.tool, recommendationId: recommendation.id },
                  },
                  provenance: {
                    sourceKind: 'SYSTEM' as const,
                    sourceRef: `recommendation:${recommendation.id}`,
                    actor: ENGINE_ACTOR,
                    recordedBy: 'cases.engine',
                  },
                  occurredAt: this.deps.clock.now(),
                },
              ]
            : []),
        ],
        current.version,
      );
      if (!appended.ok) return err(appended.error);
      await this.applyAll(scope, appended.value);
      await this.settle(scope, current.id);
      const actions = await this.deps.cases.listActions(scope, current.id);
      const action = actions.find((a) => a.id === actionId);
      return action === undefined
        ? err(new NotFoundError('ACTION_NOT_FOUND', 'The action record was not found.'))
        : ok(action);
    });
  }

  /** Resolves or dismisses a case by hand (informational cases, NON_DETERMINATO cases). */
  async resolve(
    tenant: TenantContext,
    caseId: CaseId,
    resolution: 'resolved_manually' | 'dismissed',
    note: string | null,
  ): Promise<Result<Case, DomainError>> {
    const permitted = this.deps.authorizer.require(tenant, Permission.DECISIONS_APPROVE);
    if (!permitted.ok) return err(permitted.error);
    return this.deps.transactions.withTenant(tenant.organizationId, async (scope) => {
      const current = await this.deps.cases.findCase(scope, caseId);
      if (current === undefined)
        return err(new NotFoundError('CASE_NOT_FOUND', 'The case was not found.'));
      if (current.status === 'resolved' || current.status === 'dismissed') {
        return err(
          new PreconditionFailedError('CASE_ALREADY_CLOSED', 'The case is already closed.'),
        );
      }
      const pending = (await this.deps.cases.listRecommendations(scope, caseId)).filter(
        (r) => r.status === 'approved',
      );
      if (pending.length > 0) {
        return err(
          new PreconditionFailedError(
            'ACTIONS_PENDING',
            'Approved recommendations are still executing.',
          ),
        );
      }
      const appended = await this.deps.ledger.append(
        scope,
        { type: CASE_STREAM_TYPE, id: caseId },
        [
          {
            eventType: CaseEventType.RESOLVED,
            schemaVersion: 1,
            payload: { resolution, note },
            provenance: {
              sourceKind: 'USER',
              sourceRef: `user:${tenant.userId}`,
              actor: { type: ActorType.USER, id: tenant.userId },
              recordedBy: 'cases.engine',
            },
            occurredAt: this.deps.clock.now(),
          },
        ],
        current.version,
      );
      if (!appended.ok) return err(appended.error);
      await this.applyAll(scope, appended.value);
      return ok(await this.requireCase(scope, caseId));
    });
  }

  async detail(scope: TenantScope, caseId: CaseId): Promise<CaseDetail | undefined> {
    const current = await this.deps.cases.findCase(scope, caseId);
    if (current === undefined) return undefined;
    // Sequential on purpose: the scope owns one connection, and pg forbids overlapping queries on it.
    const findings = await this.deps.cases.listFindings(scope, caseId);
    const recommendations = await this.deps.cases.listRecommendations(scope, caseId);
    const approvals = await this.deps.cases.listApprovals(scope, caseId);
    const actions = await this.deps.cases.listActions(scope, caseId);
    return { case: current, findings, recommendations, approvals, actions };
  }

  /**
   * Refuses a draft that cites a span which is not in the document it names.
   * A system that fabricates a citation has a defect; the case is not stored,
   * so a fabricated fact never reaches a human as if it were grounded.
   */
  private async verifyEvidence(
    tenantId: OrganizationId,
    draft: CaseDraft,
  ): Promise<Result<void, DomainError>> {
    const verifier = this.deps.evidence;
    if (verifier === undefined) return ok(undefined);
    const cited = [
      ...draft.findings.flatMap((finding) => finding.evidence),
      ...(draft.nonDeterminato?.evidence ?? []),
      ...(draft.nonDeterminato?.known ?? []).flatMap((known) => known.evidence),
      ...(draft.nonDeterminato?.conflicts ?? []).flatMap((conflict) => conflict.evidence),
    ];
    if (cited.length === 0) return ok(undefined);
    const report = await this.deps.transactions.withTenant(tenantId, (scope) =>
      verifier.verify(scope, cited),
    );
    if (report.rejected.length === 0) return ok(undefined);
    this.logger.warn('case draft cited evidence that does not verify', {
      checked: report.checked,
      rejected: report.rejected.length,
    });
    return err(
      new ValidationError(
        'FABRICATED_EVIDENCE',
        'The draft cites evidence that is not in the document it names.',
        {
          details: {
            checked: report.checked,
            rejected: report.rejected.map((item) => ({
              reason: item.reason,
              sourceRef: item.evidence.sourceRef,
              content: item.evidence.content.slice(0, 120),
            })),
          },
        },
      ),
    );
  }

  private async prepareRecommendations(
    tenantId: OrganizationId,
    draft: CaseDraft,
  ): Promise<
    Result<
      {
        recommendationId: string;
        tool: string;
        input: unknown;
        inputHash: string;
        rationale: string;
        level: Recommendation['level'];
        policyVersion: number;
      }[],
      DomainError
    >
  > {
    const prepared = [];
    for (const recommendation of draft.recommendations) {
      const tool = this.deps.tools.get(recommendation.tool);
      if (tool === undefined) {
        return err(
          new ValidationError(
            'UNKNOWN_RECOMMENDATION_TOOL',
            `The recommendation names a tool that does not exist: "${recommendation.tool}".`,
          ),
        );
      }
      const input = tool.input.safeParse(recommendation.input);
      if (!input.success) {
        return err(
          validationErrorFromZod(
            input.error,
            'INVALID_RECOMMENDATION_INPUT',
            `The input proposed for "${recommendation.tool}" is invalid.`,
          ),
        );
      }
      if (tool.effect === 'read' || tool.effect === 'analyze') {
        return err(
          new ValidationError(
            'RECOMMENDATION_NOT_AN_ACTION',
            `A recommendation must name a draft or act tool; "${recommendation.tool}" is a ${tool.effect} tool.`,
          ),
        );
      }
      const resolution = await this.deps.policy.resolve(tenantId, tool);
      prepared.push({
        recommendationId: newUuid(),
        tool: tool.name,
        input: input.data,
        inputHash: digestOf(input.data),
        rationale: recommendation.rationale,
        level: resolution.level,
        policyVersion: resolution.version,
      });
    }
    return ok(prepared);
  }

  private async applyAll(scope: TenantScope, events: readonly LedgerEvent[]): Promise<void> {
    for (const event of events) await this.deps.projection.apply(scope, event);
  }

  /** Closes the case when no recommendation is pending: actioned if anything ran, dismissed if everything was rejected. */
  private async settle(scope: TenantScope, caseId: CaseId): Promise<void> {
    const current = await this.requireCase(scope, caseId);
    if (current.status === 'resolved' || current.status === 'dismissed') return;
    const recommendations = await this.deps.cases.listRecommendations(scope, caseId);
    if (recommendations.length === 0) return;
    const pending = recommendations.some((r) => r.status === 'proposed' || r.status === 'approved');
    if (pending) return;
    const executed = recommendations.some((r) => r.status === 'executed');
    const failed = recommendations.some((r) => r.status === 'failed');
    if (failed && !executed) return; // a failed action keeps the case open for a human
    const resolution = executed ? CaseResolution.ACTIONED : CaseResolution.DISMISSED;
    const appended = await this.deps.ledger.append(
      scope,
      { type: CASE_STREAM_TYPE, id: caseId },
      [
        {
          eventType: CaseEventType.RESOLVED,
          schemaVersion: 1,
          payload: { resolution, note: null },
          provenance: {
            sourceKind: 'SYSTEM',
            sourceRef: `case:${caseId}`,
            actor: ENGINE_ACTOR,
            recordedBy: 'cases.engine',
          },
          occurredAt: this.deps.clock.now(),
        },
      ],
      current.version,
    );
    if (appended.ok) await this.applyAll(scope, appended.value);
  }

  private async loadOpened(scope: TenantScope, caseId: CaseId): Promise<OpenedCase> {
    const current = await this.requireCase(scope, caseId);
    const findings = await this.deps.cases.listFindings(scope, caseId);
    const recommendations = await this.deps.cases.listRecommendations(scope, caseId);
    return { case: current, findings, recommendations };
  }

  private async requireCase(scope: TenantScope, caseId: CaseId): Promise<Case> {
    const current = await this.deps.cases.findCase(scope, caseId);
    if (current === undefined) throw new NotFoundError('CASE_NOT_FOUND', 'The case was not found.');
    return current;
  }

  /** The approver's tenant context, so an action runs with the permissions of the human who approved it. */
  private async tenantFor(
    scope: TenantScope,
    userId: TenantContext['userId'],
  ): Promise<TenantContext> {
    const membership = await this.deps.memberships.find(scope, scope.tenantId, userId);
    if (membership?.status !== 'active') {
      throw new ForbiddenError(
        'APPROVER_NOT_A_MEMBER',
        'The approver is no longer a member of the organization.',
      );
    }
    return {
      organizationId: scope.tenantId,
      organizationSlug: 'tenant',
      userId,
      roleKey: membership.roleKey,
    };
  }
}

/** Placeholder user id for automation; never a real membership. */
const ENGINE_USER_ID = '00000000-0000-0000-0000-000000000000' as TenantContext['userId'];
