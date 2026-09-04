import { ForbiddenError } from '../../../../kernel/errors.js';
import type { OrganizationId } from '../../../../kernel/ids.js';
import type { Scope, TenantScope } from '../../../../kernel/scope.js';
import type { ActionIntentRepository } from '../../application/ports.js';
import type { ActionIntent, ActionIntentState } from '../../domain/action-intent.js';

/**
 * The entitlement store for tests and the in-memory chain.
 *
 * `lock` here is a promise queue per recommendation rather than a row lock:
 * one caller at a time, the rest waiting their turn, which reproduces the
 * behaviour PostgreSQL gives through `SELECT … FOR UPDATE` closely enough for
 * a unit test to be meaningful. It is a model of the guarantee, not the
 * guarantee itself — the invariant that matters is asserted against a real
 * database in `tests/integration/cases.test.ts`.
 */
export class InMemoryActionIntentRepository implements ActionIntentRepository {
  readonly intents = new Map<string, ActionIntent>();
  /** One chain per recommendation: awaiting it is waiting for the holder to finish. */
  private readonly turns = new Map<string, Promise<void>>();

  async insert(scope: Scope, intent: ActionIntent): Promise<void> {
    if (!visible(scope, intent.organizationId)) refuse();
    // The database has a primary key here: a second insert changes nothing.
    if (this.intents.has(intent.recommendationId)) return;
    this.intents.set(intent.recommendationId, intent);
  }

  async lock(scope: TenantScope, recommendationId: string): Promise<ActionIntent | undefined> {
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waitFor = this.turns.get(recommendationId);
    this.turns.set(recommendationId, mine);
    if (waitFor !== undefined) await waitFor;
    // Released when the caller's transaction ends, which the runner reports by
    // clearing the turn; see `releaseAll`. A test that never ends a transaction
    // would deadlock exactly as PostgreSQL would.
    this.releases.set(recommendationId, release);
    const intent = this.intents.get(recommendationId);
    if (intent === undefined || !visible(scope, intent.organizationId)) {
      this.release(recommendationId);
      return undefined;
    }
    return intent;
  }

  async find(scope: Scope, recommendationId: string): Promise<ActionIntent | undefined> {
    const intent = this.intents.get(recommendationId);
    return intent !== undefined && visible(scope, intent.organizationId) ? intent : undefined;
  }

  async settle(
    scope: Scope,
    recommendationId: string,
    patch: {
      readonly state: ActionIntentState;
      readonly attempts: number;
      readonly externalRef?: string | null;
      readonly lastError?: string | null;
      readonly updatedAt: Date;
    },
  ): Promise<void> {
    const intent = this.intents.get(recommendationId);
    if (intent === undefined) return;
    if (!visible(scope, intent.organizationId)) refuse();
    this.intents.set(recommendationId, {
      ...intent,
      state: patch.state,
      attempts: patch.attempts,
      externalRef: patch.externalRef ?? intent.externalRef,
      lastError: patch.lastError ?? null,
      updatedAt: patch.updatedAt,
    });
  }

  async listTenantsWithUnfinished(scope: Scope, limit: number): Promise<OrganizationId[]> {
    const tenants = new Set<OrganizationId>();
    for (const intent of this.intents.values()) {
      if (intent.state === 'sent') continue;
      if (!visible(scope, intent.organizationId)) continue;
      tenants.add(intent.organizationId);
    }
    return [...tenants].sort().slice(0, limit);
  }

  async listUnfinished(scope: TenantScope, limit: number): Promise<ActionIntent[]> {
    return [...this.intents.values()]
      .filter((intent) => visible(scope, intent.organizationId) && intent.state !== 'sent')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
  }

  private readonly releases = new Map<string, () => void>();

  /** Ends the caller's turn, as committing or rolling back a transaction does. */
  release(recommendationId: string): void {
    const release = this.releases.get(recommendationId);
    if (release === undefined) return;
    this.releases.delete(recommendationId);
    release();
  }

  /** Ends every turn. The in-memory transaction runner calls it when a scope closes. */
  releaseAll(): void {
    for (const key of [...this.releases.keys()]) this.release(key);
  }
}

const visible = (scope: Scope, organizationId: string): boolean =>
  scope.kind === 'system' || scope.tenantId === organizationId;

const refuse = (): never => {
  throw new ForbiddenError('DATABASE_ACCESS_DENIED', 'Row-level security refused the write.');
};
