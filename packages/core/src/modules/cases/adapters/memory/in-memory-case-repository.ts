import { ForbiddenError } from '../../../../kernel/errors.js';
import type { CaseId, DocumentId } from '../../../../kernel/ids.js';
import type { Scope, TenantScope } from '../../../../kernel/scope.js';
import type { CaseQuery, CaseRepository } from '../../application/ports.js';
import type { ActionRecord, Approval, Case, Finding, Recommendation } from '../../domain/case.js';

const PRIORITY_RANK: Record<Case['priority'], number> = { high: 0, normal: 1, low: 2 };

const visible = (scope: Scope, organizationId: string): boolean =>
  scope.kind === 'system' || scope.tenantId === organizationId;

const refuse = (): never => {
  throw new ForbiddenError('DATABASE_ACCESS_DENIED', 'Row-level security refused the write.');
};

/** Same visibility as the database; rebuildable through `reset`. */
export class InMemoryCaseRepository implements CaseRepository {
  readonly cases = new Map<CaseId, Case>();
  readonly findings: Finding[] = [];
  readonly recommendations = new Map<string, Recommendation>();
  readonly approvals: Approval[] = [];
  readonly actions: ActionRecord[] = [];

  async upsertCase(scope: Scope, item: Case): Promise<void> {
    if (!visible(scope, item.organizationId)) refuse();
    this.cases.set(item.id, item);
  }

  async findCase(scope: Scope, id: CaseId): Promise<Case | undefined> {
    const item = this.cases.get(id);
    return item !== undefined && visible(scope, item.organizationId) ? item : undefined;
  }

  async findCasesForDocument(
    scope: Scope,
    documentId: DocumentId,
    systemKey: string,
  ): Promise<Case[]> {
    return [...this.cases.values()].filter(
      (item) =>
        visible(scope, item.organizationId) &&
        item.systemKey === systemKey &&
        item.subjects.some((s) => s.type === 'document' && s.id === documentId),
    );
  }

  async listCases(scope: TenantScope, query: CaseQuery): Promise<Case[]> {
    return [...this.cases.values()]
      .filter((item) => item.organizationId === scope.tenantId)
      .filter((item) => query.statuses === undefined || query.statuses.includes(item.status))
      .filter((item) => query.systemKey === undefined || item.systemKey === query.systemKey)
      .filter((item) => query.kind === undefined || item.kind === query.kind)
      .filter((item) => query.before === undefined || item.openedAt < query.before)
      .sort(
        (a, b) =>
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          b.openedAt.getTime() - a.openedAt.getTime(),
      )
      .slice(0, query.limit);
  }

  async insertFinding(scope: Scope, finding: Finding): Promise<void> {
    if (!visible(scope, finding.organizationId)) refuse();
    this.findings.push(finding);
  }

  async listFindings(scope: Scope, caseId: CaseId): Promise<Finding[]> {
    return this.findings.filter((f) => f.caseId === caseId && visible(scope, f.organizationId));
  }

  async upsertRecommendation(scope: Scope, recommendation: Recommendation): Promise<void> {
    if (!visible(scope, recommendation.organizationId)) refuse();
    this.recommendations.set(recommendation.id, recommendation);
  }

  async findRecommendation(scope: Scope, id: string): Promise<Recommendation | undefined> {
    const item = this.recommendations.get(id);
    return item !== undefined && visible(scope, item.organizationId) ? item : undefined;
  }

  async listRecommendations(scope: Scope, caseId: CaseId): Promise<Recommendation[]> {
    return [...this.recommendations.values()]
      .filter((r) => r.caseId === caseId && visible(scope, r.organizationId))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async insertApproval(scope: Scope, approval: Approval): Promise<void> {
    if (!visible(scope, approval.organizationId)) refuse();
    this.approvals.push(approval);
  }

  async listApprovals(scope: Scope, caseId: CaseId): Promise<Approval[]> {
    return this.approvals.filter((a) => a.caseId === caseId && visible(scope, a.organizationId));
  }

  async insertAction(scope: Scope, action: ActionRecord): Promise<void> {
    if (!visible(scope, action.organizationId)) refuse();
    this.actions.push(action);
  }

  async listActions(scope: Scope, caseId: CaseId): Promise<ActionRecord[]> {
    return this.actions.filter((a) => a.caseId === caseId && visible(scope, a.organizationId));
  }

  async reset(_scope: Scope): Promise<void> {
    this.cases.clear();
    this.findings.length = 0;
    this.recommendations.clear();
    this.approvals.length = 0;
    this.actions.length = 0;
  }
}
