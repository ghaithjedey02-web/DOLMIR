import type { z } from 'zod';

import type { Actor } from '../../kernel/context.js';
import { type DomainError, InternalError } from '../../kernel/errors.js';
import type { Result } from '../../kernel/result.js';
import type { TenantScope } from '../../kernel/scope.js';
import type { TenantContext } from '../../kernel/tenant.js';
import type { Permission } from '../../modules/access/index.js';
import type { ToolEffect } from './policy.js';

/**
 * Typed tools are the only way a model causes an effect (ADR-0006 §4).
 * A tool is a schema pair, a permission, an effect and a deterministic
 * handler. The handler receives validated input and the caller's tenant
 * context and scope; it never receives credentials, a connection or the
 * model's raw text.
 */
export interface ToolContext {
  /** Who is acting, in which organisation, as what — resolved by the platform, never by the model. */
  readonly tenant: TenantContext;
  /** The acting principal as the audit log records it (an AI actor names the principal it acts for). */
  readonly actor: Actor;
  /** The transaction the tool runs in; repositories take it as their first argument. */
  readonly scope: TenantScope;
  /**
   * Stable identity of this attempt, when the caller has one. A tool with an
   * external effect passes it on, so a retry is recognisable as the same act
   * rather than a new one. Absent for calls that are not retried.
   */
  readonly idempotencyKey?: string;
}

export interface ToolDefinition<I, O> {
  /** `snake_case`, unique in a registry. */
  readonly name: string;
  /** Written for the model: what the tool does and when to call it. */
  readonly description: string;
  readonly effect: ToolEffect;
  readonly permission: Permission;
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  handler(input: I, context: ToolContext): Promise<Result<O, DomainError>>;
}

export type AnyToolDefinition = ToolDefinition<unknown, unknown>;

export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

/** Validates a definition at wiring time; a malformed tool is a programming error, not a runtime result. */
export function defineTool<I, O>(definition: ToolDefinition<I, O>): ToolDefinition<I, O> {
  if (!TOOL_NAME_PATTERN.test(definition.name)) {
    throw new InternalError(
      'INVALID_TOOL_NAME',
      `Tool name "${definition.name}" must be snake_case (2–64 characters).`,
    );
  }
  if (definition.description.trim().length < 10) {
    throw new InternalError(
      'INVALID_TOOL_DESCRIPTION',
      `Tool "${definition.name}" needs a description the model can act on.`,
    );
  }
  return Object.freeze({ ...definition });
}
