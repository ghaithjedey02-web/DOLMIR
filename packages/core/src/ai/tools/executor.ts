import type { Clock } from '../../kernel/clock.js';
import { ActorType } from '../../kernel/context.js';
import {
  type DomainError,
  type DomainErrorRecord,
  ErrorCategory,
  ForbiddenError,
  InternalError,
  NotFoundError,
  toDomainError,
  validationErrorFromZod,
} from '../../kernel/errors.js';
import { type Logger, noopLogger } from '../../kernel/logger.js';
import { type Authorizer, HUMAN_ONLY_PERMISSIONS } from '../../modules/access/index.js';
import type { AuditOutcome, AuditRecorder } from '../../modules/audit/index.js';
import { digestOf } from '../shared/canonical-json.js';
import type { AnyToolDefinition, ToolContext } from './define-tool.js';
import { type ActionPolicy, type PolicyLevel, levelPermitsExecution } from './policy.js';
import type { ToolRegistry } from './registry.js';

/** A persisted human approval the caller presents for an `act` tool (verified against a store from Phase 2). */
export interface ApprovalRef {
  readonly id: string;
  readonly toolName: string;
  /** Digest of the exact validated input the human approved. */
  readonly inputHash: string;
}

export interface ToolCall {
  readonly name: string;
  readonly input: unknown;
  /** The model's call id, when the call comes from a model turn. */
  readonly callId?: string;
  readonly approval?: ApprovalRef;
}

export type ToolExecutionResult =
  | {
      readonly status: 'ok';
      readonly tool: string;
      readonly callId: string | undefined;
      readonly level: PolicyLevel;
      readonly output: unknown;
    }
  | {
      readonly status: 'error';
      readonly tool: string;
      readonly callId: string | undefined;
      readonly error: DomainErrorRecord;
    }
  | {
      readonly status: 'approval_required';
      readonly tool: string;
      readonly callId: string | undefined;
      readonly level: PolicyLevel;
      readonly policyVersion: number;
      readonly inputHash: string;
    }
  | {
      readonly status: 'not_permitted';
      readonly tool: string;
      readonly callId: string | undefined;
      readonly level: PolicyLevel;
      readonly policyVersion: number;
      readonly reason: string;
    };

export interface ToolExecutorDependencies {
  readonly registry: ToolRegistry;
  readonly authorizer: Authorizer;
  readonly policy: ActionPolicy;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
  readonly logger?: Logger;
}

export const TOOL_AUDIT_ACTION = 'tool.executed';

/**
 * Runs a tool for a caller (ADR-0006 §4, ADR-0011): permission check through
 * the access module, human-only permissions refused to AI actors, input
 * validated, action policy applied, handler run, output validated, and one
 * audit entry whatever happened. Expected failures come back as structured
 * results a model can act on; infrastructure and internal failures are
 * rethrown after being audited, because the run cannot sensibly continue.
 */
export class ToolExecutor {
  private readonly deps: ToolExecutorDependencies;
  private readonly logger: Logger;

  constructor(deps: ToolExecutorDependencies) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
  }

  async execute(context: ToolContext, call: ToolCall): Promise<ToolExecutionResult> {
    const tool = this.deps.registry.get(call.name);
    if (tool === undefined) {
      const error = new NotFoundError('UNKNOWN_TOOL', `No tool named "${call.name}" exists.`);
      await this.audit(context, call.name, 'failure', { callId: call.callId, error: brief(error) });
      return { status: 'error', tool: call.name, callId: call.callId, error: error.toRecord() };
    }
    const base = {
      callId: call.callId,
      effect: tool.effect,
      permission: tool.permission,
    };

    if (context.actor.type === ActorType.AI && HUMAN_ONLY_PERMISSIONS.has(tool.permission)) {
      const error = new ForbiddenError(
        'HUMAN_ONLY_PERMISSION',
        'This action can only be taken by a human.',
        { details: { permission: tool.permission } },
      );
      await this.audit(context, tool.name, 'denied', { ...base, error: brief(error) });
      return { status: 'error', tool: tool.name, callId: call.callId, error: error.toRecord() };
    }

    const permitted = this.deps.authorizer.require(context.tenant, tool.permission);
    if (!permitted.ok) {
      await this.audit(context, tool.name, 'denied', { ...base, error: brief(permitted.error) });
      return {
        status: 'error',
        tool: tool.name,
        callId: call.callId,
        error: permitted.error.toRecord(),
      };
    }

    const input = tool.input.safeParse(call.input);
    if (!input.success) {
      const error = validationErrorFromZod(
        input.error,
        'INVALID_TOOL_INPUT',
        `The input of tool "${tool.name}" is invalid.`,
      );
      await this.audit(context, tool.name, 'failure', { ...base, error: brief(error) });
      return { status: 'error', tool: tool.name, callId: call.callId, error: error.toRecord() };
    }
    const inputHash = digestOf(input.data);

    const policy = await this.deps.policy.resolve(context.tenant.organizationId, tool);
    const policyDetails = {
      ...base,
      inputHash,
      level: policy.level,
      policyVersion: policy.version,
      policySource: policy.source,
    };
    if (!levelPermitsExecution(tool.effect, policy.level)) {
      const reason = `Policy level ${policy.level} does not allow executing a ${tool.effect} tool.`;
      await this.audit(context, tool.name, 'denied', { ...policyDetails, reason });
      return {
        status: 'not_permitted',
        tool: tool.name,
        callId: call.callId,
        level: policy.level,
        policyVersion: policy.version,
        reason,
      };
    }
    if (policy.level === 'REQUIRE_APPROVAL') {
      const approval = call.approval;
      const matches = approval?.toolName === tool.name && approval.inputHash === inputHash;
      if (!matches) {
        await this.audit(context, tool.name, 'denied', {
          ...policyDetails,
          reason: 'approval_required',
        });
        return {
          status: 'approval_required',
          tool: tool.name,
          callId: call.callId,
          level: policy.level,
          policyVersion: policy.version,
          inputHash,
        };
      }
    }

    const started = this.deps.clock.now().getTime();
    let outcome: Awaited<ReturnType<AnyToolDefinition['handler']>>;
    try {
      outcome = await tool.handler(input.data, context);
    } catch (thrown) {
      const error = toDomainError(thrown, 'TOOL_HANDLER_THREW');
      await this.audit(context, tool.name, 'failure', { ...policyDetails, error: brief(error) });
      throw error;
    }
    const durationMs = Math.max(0, this.deps.clock.now().getTime() - started);

    if (!outcome.ok) {
      const details = { ...policyDetails, durationMs, error: brief(outcome.error) };
      await this.audit(context, tool.name, 'failure', details);
      if (isUnrecoverable(outcome.error)) throw outcome.error;
      return {
        status: 'error',
        tool: tool.name,
        callId: call.callId,
        error: outcome.error.toRecord(),
      };
    }

    const output = tool.output.safeParse(outcome.value);
    if (!output.success) {
      const error = new InternalError(
        'TOOL_OUTPUT_INVALID',
        `Tool "${tool.name}" produced output that violates its own schema.`,
        { cause: validationErrorFromZod(output.error) },
      );
      await this.audit(context, tool.name, 'failure', {
        ...policyDetails,
        durationMs,
        error: brief(error),
      });
      this.logger.error('tool output invalid', {
        tool: tool.name,
        issues: output.error.issues.length,
      });
      throw error;
    }

    await this.audit(context, tool.name, 'success', {
      ...policyDetails,
      durationMs,
      outputHash: digestOf(output.data),
      ...(call.approval === undefined ? {} : { approvalId: call.approval.id }),
    });
    return {
      status: 'ok',
      tool: tool.name,
      callId: call.callId,
      level: policy.level,
      output: output.data,
    };
  }

  private async audit(
    context: ToolContext,
    toolName: string,
    outcome: AuditOutcome,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record(context.scope, {
      organizationId: context.tenant.organizationId,
      actor: context.actor,
      action: TOOL_AUDIT_ACTION,
      target: { type: 'tool', id: toolName.slice(0, 255) },
      outcome,
      details,
    });
  }
}

function brief(error: DomainError): { code: string; category: string } {
  return { code: error.code, category: error.category };
}

function isUnrecoverable(error: DomainError): boolean {
  return (
    error.category === ErrorCategory.INFRASTRUCTURE || error.category === ErrorCategory.INTERNAL
  );
}
