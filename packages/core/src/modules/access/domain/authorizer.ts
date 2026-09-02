import { ForbiddenError } from '../../../kernel/errors.js';
import { err, ok, type Result } from '../../../kernel/result.js';
import type { RoleKey, TenantContext } from '../../../kernel/tenant.js';
import { type Permission, ROLE_MATRIX_VERSION, ROLE_PERMISSIONS } from './permissions.js';

/** The record of one authorisation decision, in the shape the audit log stores. */
export interface AccessDecision {
  readonly allowed: boolean;
  readonly permission: Permission;
  readonly roleKey: RoleKey;
  readonly matrixVersion: number;
}

/**
 * Deterministic authorisation. Pure: same context and permission, same
 * answer, every time — which is what lets a model act only through tools that
 * cannot talk their way past it (ADR-0006).
 */
export class Authorizer {
  permissionsFor(roleKey: RoleKey): ReadonlySet<Permission> {
    return ROLE_PERMISSIONS[roleKey];
  }

  decide(context: Pick<TenantContext, 'roleKey'>, permission: Permission): AccessDecision {
    return {
      allowed: ROLE_PERMISSIONS[context.roleKey].has(permission),
      permission,
      roleKey: context.roleKey,
      matrixVersion: ROLE_MATRIX_VERSION,
    };
  }

  can(context: Pick<TenantContext, 'roleKey'>, permission: Permission): boolean {
    return this.decide(context, permission).allowed;
  }

  require(
    context: Pick<TenantContext, 'roleKey'>,
    permission: Permission,
  ): Result<AccessDecision, ForbiddenError> {
    const decision = this.decide(context, permission);
    if (!decision.allowed) {
      return err(
        new ForbiddenError('PERMISSION_DENIED', 'You do not have permission for this action.', {
          details: { permission, roleKey: context.roleKey, matrixVersion: ROLE_MATRIX_VERSION },
        }),
      );
    }
    return ok(decision);
  }
}

export const authorizer = new Authorizer();
