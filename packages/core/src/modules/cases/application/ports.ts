import type { CaseId, DocumentId } from '../../../kernel/ids.js';
import type { Scope, TenantScope } from '../../../kernel/scope.js';
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
