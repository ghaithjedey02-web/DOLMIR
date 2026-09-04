import type { CaseId, DocumentId, OrganizationId } from '../../../kernel/ids.js';
import type { Scope, TenantScope } from '../../../kernel/scope.js';
import type { ActionIntent, ActionIntentState } from '../domain/action-intent.js';
import type {
  ActionRecord,
  Approval,
  Case,
  CaseStatus,
  Finding,
  Recommendation,
} from '../domain/case.js';

export interface CaseQuery {
  readonly limit: number;
  readonly statuses?: readonly CaseStatus[];
  readonly systemKey?: string;
  readonly kind?: string;
  /** Only cases opened strictly before this instant (paging). */
  readonly before?: Date;
}

/**
 * The case read model (ADR-0012 §3): written only by the projection, in the
 * same transaction as the events it derives from. `reset` exists for
 * rebuilds and needs the owner role — the runtime role never deletes.
 */
export interface CaseRepository {
  upsertCase(scope: Scope, item: Case): Promise<void>;
  findCase(scope: Scope, id: CaseId): Promise<Case | undefined>;
  /** Cases whose subjects include the document, for one system (idempotent analysis). */
  findCasesForDocument(scope: Scope, documentId: DocumentId, systemKey: string): Promise<Case[]>;
  listCases(scope: TenantScope, query: CaseQuery): Promise<Case[]>;
  insertFinding(scope: Scope, finding: Finding): Promise<void>;
  listFindings(scope: Scope, caseId: CaseId): Promise<Finding[]>;
  upsertRecommendation(scope: Scope, recommendation: Recommendation): Promise<void>;
  findRecommendation(scope: Scope, id: string): Promise<Recommendation | undefined>;
  listRecommendations(scope: Scope, caseId: CaseId): Promise<Recommendation[]>;
  insertApproval(scope: Scope, approval: Approval): Promise<void>;
  listApprovals(scope: Scope, caseId: CaseId): Promise<Approval[]>;
  insertAction(scope: Scope, action: ActionRecord): Promise<void>;
  listActions(scope: Scope, caseId: CaseId): Promise<ActionRecord[]>;
  /** Empties the read model (rebuild). Requires a role that may delete. */
  reset(scope: Scope): Promise<void>;
}

/**
 * The durable record of what the platform is entitled to execute, and the lock
 * that makes an attempt exclusive. It is not a projection: it is written in
 * the transaction that authorises the work, and it survives the process.
 */
export interface ActionIntentRepository {
  /**
   * Records the entitlement. Idempotent: a second call for the same
   * recommendation leaves the first row untouched, so re-approving or
   * re-opening cannot multiply the intent.
   */
  insert(scope: Scope, intent: ActionIntent): Promise<void>;
  /**
   * Takes the row for update inside the caller's transaction. A second caller
   * blocks here until the first commits — that is the concurrency guarantee,
   * enforced by the database rather than by any flag this process holds.
   * `undefined` when no entitlement exists, or when it belongs to another
   * tenant and row-level security hides it.
   */
  lock(scope: TenantScope, recommendationId: string): Promise<ActionIntent | undefined>;
  find(scope: Scope, recommendationId: string): Promise<ActionIntent | undefined>;
  /** Records the conclusion of one attempt, in the same transaction as its effects. */
  settle(
    scope: Scope,
    recommendationId: string,
    patch: {
      readonly state: ActionIntentState;
      readonly attempts: number;
      readonly externalRef?: string | null;
      readonly lastError?: string | null;
      readonly updatedAt: Date;
    },
  ): Promise<void>;
  /** Entitlements that have not reached a conclusion, for a retry sweep. */
  listUnfinished(scope: TenantScope, limit: number): Promise<ActionIntent[]>;
  /**
   * The tenants holding unfinished work, and nothing else about it. A recovery
   * sweep runs across tenants and so needs a system scope, which is exactly
   * why this returns identifiers rather than rows: the sweep learns which
   * tenants to visit, and reads their entitlements inside their own scope,
   * under row-level security, through `listUnfinished`.
   */
  listTenantsWithUnfinished(scope: Scope, limit: number): Promise<OrganizationId[]>;
}

/**
 * How an authorised action reaches a worker. The composition root enqueues the
 * job; the cases module does not know what a queue is — the same shape the
 * connectors module uses to schedule analysis.
 */
export interface ExecutionScheduler {
  scheduleExecution(tenantId: OrganizationId, recommendationId: string): Promise<void>;
}
