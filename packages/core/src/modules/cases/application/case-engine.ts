import { type Actor, ActorType } from '../../../kernel/context.js';
import type { Clock } from '../../../kernel/clock.js';
import {
  type DomainError,
  ForbiddenError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
  toDomainError,
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
import {
  type ActionIntent,
  ActionIntentState,
  actionIdempotencyKey,
} from '../domain/action-intent.js';
import { CASE_STREAM_TYPE, CaseEventType, CaseResolution } from '../domain/case-events.js';
import type { CaseProjection } from './case-projection.js';
import type { EvidenceVerifier } from './evidence-verifier.js';
import type { ActionIntentRepository, CaseRepository, ExecutionScheduler } from './ports.js';

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
  /** Where the entitlement to act is recorded and locked. */
  readonly intents: ActionIntentRepository;
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
  /**
   * Hands an authorised action to a worker once its transaction has committed.
   * Absent in tests that drive execution themselves; the entitlement is
   * durable either way, so a lost enqueue is recoverable rather than fatal.
   */
  readonly scheduler?: ExecutionScheduler;
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
      // An AUTO_EXECUTE recommendation is authorised by the company's own
      // policy rather than by a person, so its entitlement is recorded here,
      // in the transaction that proposes it. Everything else waits for a human.
      for (const recommendation of opened.recommendations) {
        if (recommendation.level !== 'AUTO_EXECUTE') continue;
        await this.recordIntent(scope, tenantId, recommendation);
      }
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
      if (updated === undefined) {
        return err(
          new NotFoundError('RECOMMENDATION_NOT_FOUND', 'The recommendation was not found.'),
        );
      }
      // The entitlement is recorded in the very transaction that grants it, so
      // an approval that commits is work that will happen: nothing downstream
      // depends on this process, or this request, still being alive.
      if (decision === 'approved') {
        await this.recordIntent(scope, tenant.organizationId, updated);
      }
      return ok(updated);
    });
  }

  /**
   * Records the platform's entitlement to carry out one recommendation.
   * Idempotent, so re-approving or re-opening cannot multiply it.
   */
  private async recordIntent(
    scope: TenantScope,
    tenantId: OrganizationId,
    recommendation: Recommendation,
  ): Promise<void> {
    const now = this.deps.clock.now();
    const intent: ActionIntent = {
      organizationId: tenantId,
      recommendationId: recommendation.id,
      caseId: recommendation.caseId,
      tool: recommendation.tool,
      inputHash: recommendation.inputHash,
      idempotencyKey: actionIdempotencyKey(recommendation.id, recommendation.inputHash),
      state: ActionIntentState.PENDING,
      attempts: 0,
      externalRef: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.intents.insert(scope, intent);
  }

  /**
   * Hands an authorised recommendation to a worker. Called after the granting
   * transaction has committed, so the queue never learns about work that was
   * rolled back. A scheduler failure is logged, not raised: the entitlement is
   * already durable, and a sweep can pick it up.
   */
  async scheduleExecution(tenantId: OrganizationId, recommendationId: string): Promise<void> {
    const scheduler = this.deps.scheduler;
    if (scheduler === undefined) return;
    try {
      await scheduler.scheduleExecution(tenantId, recommendationId);
    } catch (error) {
      this.logger.error('could not schedule an approved execution', {
        recommendationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Carries out one authorised recommendation, exactly once.
   *
   * The whole attempt runs in a single tenant transaction that begins by
   * locking the entitlement row. That lock is the concurrency guarantee: a
   * second worker waits in PostgreSQL until this one commits, and then finds
   * the terminal state and does nothing. There is no flag in this process to
   * race, and no window in which two workers both believe they may act.
   *
   * Everything the entitlement asserts is re-checked here rather than trusted
   * from the payload: that the recommendation still exists, that it is still
   * executable, that its input still hashes to what was approved, and that a
   * real approval record backs it. The action then runs under the approver's
   * own permissions.
   *
   * Retries are safe. A committed failure leaves the entitlement retryable
   * under the same identity; a committed success makes every later attempt a
   * no-op that returns the original action. The one thing this cannot cover is
   * a crash between the provider accepting the message and the commit: the
   * transaction rolls back and the retry sends again, carrying the same
   * idempotency key so the duplicate keeps one identity. Exactly-once delivery
   * across SMTP and PostgreSQL is not achievable, and is not claimed.
   */
  async execute(
    tenantId: OrganizationId,
    recommendationId: string,
  ): Promise<Result<ActionRecord, DomainError>> {
    return this.deps.transactions.withTenant(tenantId, async (scope) => {
      // Blocks while another worker holds this entitlement.
      const intent = await this.deps.intents.lock(scope, recommendationId);
      if (intent === undefined) {
        // No entitlement, or one belonging to another tenant that row-level
        // security hides. Both answers are the same, and both refuse.
        return err(
          new PreconditionFailedError(
            'NO_EXECUTION_INTENT',
            'Nothing authorises executing this recommendation.',
          ),
        );
      }

      const recommendation = await this.deps.cases.findRecommendation(scope, recommendationId);
      if (recommendation === undefined) {
        return err(
          new NotFoundError('RECOMMENDATION_NOT_FOUND', 'The recommendation was not found.'),
        );
      }
      const current = await this.requireCase(scope, recommendation.caseId);

      if (intent.state === ActionIntentState.SENT) {
        // Already carried out. Return what happened rather than doing it again.
        const actions = await this.deps.cases.listActions(scope, current.id);
        const done = actions.find(
          (action) => action.recommendationId === recommendationId && action.status === 'succeeded',
        );
        if (done !== undefined) return ok(done);
        return err(
          new PreconditionFailedError(
            'ACTION_ALREADY_EXECUTED',
            'This recommendation was already executed.',
          ),
        );
      }

      // The entitlement covers one exact input. A recommendation that no longer
      // hashes to it is a different action, and was never approved.
      if (recommendation.inputHash !== intent.inputHash) {
        const stale = new PreconditionFailedError(
          'STALE_EXECUTION_INTENT',
          'What was authorised is not what this recommendation now says.',
          { details: { approved: intent.inputHash, current: recommendation.inputHash } },
        );
        await this.failIntent(scope, intent, stale);
        return err(stale);
      }

      let approval: ApprovalRef | undefined;
      let tenant: TenantContext;
      // `failed` records what the last attempt did, not a withdrawal of the
      // approval: the entitlement still stands, so a retry is allowed exactly
      // while it has not succeeded.
      const retryingAfterFailure =
        recommendation.status === 'failed' && intent.state === ActionIntentState.FAILED;
      if (recommendation.status === 'approved' || retryingAfterFailure) {
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

      // The executor re-raises an infrastructure failure so a caller can retry.
      // Here that would roll the attempt back and take the record of the
      // failure with it, so it is caught and recorded instead: what went wrong
      // belongs on the case, and the job still retries because this returns a
      // retryable failure of its own.
      let outcome: Awaited<ReturnType<ToolExecutor['execute']>>;
      try {
        outcome = await this.deps.executor.execute(
          {
            tenant,
            actor: {
              ...ENGINE_ACTOR,
              ...(approval === undefined ? {} : { onBehalfOf: tenant.userId }),
            },
            scope,
            // Carried to the outside world so every attempt keeps one identity.
            idempotencyKey: intent.idempotencyKey,
          },
          {
            name: recommendation.tool,
            input: recommendation.input,
            callId: recommendation.id,
            idempotencyKey: intent.idempotencyKey,
            ...(approval === undefined ? {} : { approval }),
          },
        );
      } catch (thrown) {
        const failure = toDomainError(thrown, 'TOOL_EXECUTION_FAILED');
        outcome = {
          status: 'error',
          tool: recommendation.tool,
          callId: recommendation.id,
          error: failure.toRecord(),
        };
      }
      const actionId = newUuid();
      const succeeded = outcome.status === 'ok';
      const output = outcome.status === 'ok' ? outcome.output : undefined;
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
                  result: output,
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
      // The conclusion of the attempt lands in the same commit as its effects,
      // so the record and the state can never disagree.
      await this.deps.intents.settle(scope, recommendationId, {
        state: succeeded ? ActionIntentState.SENT : ActionIntentState.FAILED,
        attempts: intent.attempts + 1,
        externalRef: succeeded ? externalRefOf(output) : null,
        lastError: succeeded ? null : describeOutcome(outcome),
        updatedAt: this.deps.clock.now(),
      });
      await this.settle(scope, current.id);
      const actions = await this.deps.cases.listActions(scope, current.id);
      const action = actions.find((a) => a.id === actionId);
      if (action === undefined) {
        return err(new NotFoundError('ACTION_NOT_FOUND', 'The action record was not found.'));
      }
      // A failure is returned as a value, not thrown: the caller (a job) fails
      // the attempt so the queue retries it under the same identity.
      return succeeded
        ? ok(action)
        : err(
            new PreconditionFailedError('ACTION_FAILED', 'The action did not succeed.', {
              details: { recommendationId, attempts: intent.attempts + 1 },
              retryable: true,
            }),
          );
    });
  }

  /** Records a refusal that is not worth retrying, so the entitlement stops looking pending. */
  private async failIntent(
    scope: TenantScope,
    intent: ActionIntent,
    error: DomainError,
  ): Promise<void> {
    await this.deps.intents.settle(scope, intent.recommendationId, {
      state: ActionIntentState.FAILED,
      attempts: intent.attempts + 1,
      lastError: `${error.code}: ${error.message}`.slice(0, 2000),
      updatedAt: this.deps.clock.now(),
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

/** The provider's own name for what it accepted, when the tool reports one. */
function externalRefOf(output: unknown): string | null {
  if (typeof output !== 'object' || output === null) return null;
  const record = output as Record<string, unknown>;
  const messageId = record['messageId'];
  return typeof messageId === 'string' && messageId.length > 0 ? messageId.slice(0, 500) : null;
}

/** A short, non-secret description of why an attempt did not succeed. */
function describeOutcome(outcome: { readonly status: string }): string {
  const record = outcome as { readonly status: string; readonly error?: { code?: unknown } };
  const code = typeof record.error?.code === 'string' ? record.error.code : undefined;
  return (code === undefined ? outcome.status : `${outcome.status}: ${code}`).slice(0, 2000);
}
