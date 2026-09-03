import type { z } from 'zod';

import { type Clock, systemClock } from '../../kernel/clock.js';
import { type Logger, noopLogger } from '../../kernel/logger.js';
import type { Result } from '../../kernel/result.js';
import { type Telemetry, noopTelemetry } from '../../kernel/telemetry.js';
import {
  type LlmError,
  type LlmProviderPort,
  type LlmRequest,
  type LlmResponse,
  type LlmUsage,
  type StructuredLlmResponse,
  ZERO_USAGE,
} from '../llm/port.js';
import type { NewAiUsageRecordInput } from './ai-usage-record.js';
import type { CostBook } from './cost-book.js';
import type { AiUsageRecorder } from './ports.js';

export interface RecordedLlmProviderDependencies {
  readonly inner: LlmProviderPort;
  readonly usage: AiUsageRecorder;
  readonly costBook: CostBook;
  readonly clock?: Clock;
  readonly telemetry?: Telemetry;
  readonly logger?: Logger;
}

/**
 * Every call passes through here (ADR-0006 §6): success, failure or cache hit,
 * one `ai_usage` row with tenant, model, tier, operation, use case, tokens,
 * estimated cost and outcome. The model's answer is returned even if the row
 * cannot be written — but that failure is logged and counted, never silent.
 */
export class RecordedLlmProvider implements LlmProviderPort {
  readonly name: string;
  readonly capabilities: LlmProviderPort['capabilities'];
  private readonly deps: Required<RecordedLlmProviderDependencies>;

  constructor(deps: RecordedLlmProviderDependencies) {
    this.deps = {
      inner: deps.inner,
      usage: deps.usage,
      costBook: deps.costBook,
      clock: deps.clock ?? systemClock,
      telemetry: deps.telemetry ?? noopTelemetry,
      logger: deps.logger ?? noopLogger,
    };
    this.name = deps.inner.name;
    this.capabilities = deps.inner.capabilities;
  }

  async complete(request: LlmRequest): Promise<Result<LlmResponse, LlmError>> {
    return this.run(request, () => this.deps.inner.complete(request));
  }

  async completeStructured<T>(
    request: LlmRequest,
    schema: z.ZodType<T>,
  ): Promise<Result<StructuredLlmResponse<T>, LlmError>> {
    return this.run(request, () => this.deps.inner.completeStructured(request, schema));
  }

  private async run<R extends LlmResponse>(
    request: LlmRequest,
    call: () => Promise<Result<R, LlmError>>,
  ): Promise<Result<R, LlmError>> {
    const started = this.deps.clock.now().getTime();
    const result = await call();
    const elapsed = Math.max(0, this.deps.clock.now().getTime() - started);
    const record = result.ok
      ? this.fromResponse(request, result.value)
      : this.fromError(request, result.error, elapsed);
    await this.persist(record);
    this.observe(record);
    return result;
  }

  private fromResponse(request: LlmRequest, response: LlmResponse): NewAiUsageRecordInput {
    return this.build(request, response.model, response.usage, response.latencyMs, {
      succeeded: true,
      errorKind: null,
      cached: response.cached,
    });
  }

  private fromError(request: LlmRequest, error: LlmError, elapsed: number): NewAiUsageRecordInput {
    const attempt = error.attempt;
    return this.build(
      request,
      attempt?.model ?? 'unknown',
      attempt?.usage ?? ZERO_USAGE,
      attempt?.latencyMs ?? elapsed,
      { succeeded: false, errorKind: error.kind, cached: false },
    );
  }

  private build(
    request: LlmRequest,
    model: string,
    usage: LlmUsage,
    latencyMs: number,
    outcome: { succeeded: boolean; errorKind: string | null; cached: boolean },
  ): NewAiUsageRecordInput {
    const estimate = this.deps.costBook.estimate(model, usage);
    return {
      organizationId: request.tenantId,
      provider: this.deps.inner.name,
      model,
      tier: request.tier,
      operation: request.operation,
      useCase: request.useCase,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      estimatedCost: estimate.estimatedCost,
      currency: estimate.currency,
      pricingVersion: estimate.pricingVersion,
      priced: estimate.priced,
      latencyMs: Math.round(latencyMs),
      ...outcome,
    };
  }

  private async persist(record: NewAiUsageRecordInput): Promise<void> {
    try {
      await this.deps.usage.record(record);
    } catch (error) {
      this.deps.telemetry.count('ai.usage.record_failed', { provider: record.provider });
      this.deps.logger.error('ai usage record failed', {
        provider: record.provider,
        model: record.model,
        operation: record.operation,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private observe(record: NewAiUsageRecordInput): void {
    const tags = {
      provider: record.provider,
      model: record.model,
      tier: record.tier,
      useCase: record.useCase,
      outcome: record.succeeded ? (record.cached === true ? 'cached' : 'ok') : 'error',
    };
    this.deps.telemetry.count('ai.calls', tags);
    this.deps.telemetry.observe('ai.tokens.input', record.inputTokens, tags);
    this.deps.telemetry.observe('ai.tokens.output', record.outputTokens, tags);
    this.deps.telemetry.observe('ai.cost_usd', record.estimatedCost, tags);
    this.deps.telemetry.observe('ai.latency_ms', record.latencyMs, tags);
  }
}
