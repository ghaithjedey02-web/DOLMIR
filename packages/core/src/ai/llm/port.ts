import { z } from 'zod';

import { DomainError, type DomainErrorOptions, ErrorCategory } from '../../kernel/errors.js';
import { OrganizationIdSchema } from '../../kernel/ids.js';
import { err, ok, type Result } from '../../kernel/result.js';

/**
 * The LLM boundary (ADR-0006). Application code and AI Systems reach models
 * only through this port. A request names a *tier*, never a vendor model; the
 * response says which model answered and what it consumed. Failures are
 * values (`LlmError`) carrying whatever the provider did before failing, so
 * cost is recorded for failed calls too. Vendor exceptions never cross.
 *
 * Trust boundary: `system` carries DOLMIR's own instructions. Everything that
 * originates outside DOLMIR — e-mails, documents, records, user text — goes
 * into `messages` as data. Nothing in `messages` is ever treated as an
 * instruction to the platform, and typed tools remain the only path to an
 * effect (Direction §5, plan §K).
 */

export const LlmTier = { FAST: 'fast', STANDARD: 'standard', DEEP: 'deep' } as const;
export const LlmTierSchema = z.enum(['fast', 'standard', 'deep']);
export type LlmTier = z.infer<typeof LlmTierSchema>;

/** Lowercase, dot- or underscore-separated: `classify_document`, `rdo.extract_fields`. */
export const OperationNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/, 'must be lowercase, dot/underscore separated')
  .max(100);

export const LlmMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1),
  })
  .strict();
export type LlmMessage = z.infer<typeof LlmMessageSchema>;

export const LlmRequestSchema = z
  .object({
    /** The tenant the call is made for; `null` only for platform-level work (evals, diagnostics). */
    tenantId: OrganizationIdSchema.nullable(),
    tier: LlmTierSchema,
    /** What this call does — recorded per call in `ai_usage`. */
    operation: OperationNameSchema,
    /** The business use the call serves — the aggregation axis of cost reports. */
    useCase: OperationNameSchema,
    /** DOLMIR's own instructions. Never built from untrusted content. */
    system: z.string().min(1).optional(),
    messages: z.array(LlmMessageSchema).min(1),
    maxTokens: z.number().int().min(1).max(128_000).optional(),
    /** Extended reasoning: omitted = provider default for the model; `none` disables it; `adaptive` lets the model decide. */
    reasoning: z.enum(['none', 'adaptive']).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.messages.at(0)?.role !== 'user') {
      ctx.addIssue({
        code: 'custom',
        path: ['messages'],
        message: 'the first message must come from the user',
      });
    }
  });
export type LlmRequest = z.infer<typeof LlmRequestSchema>;

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export type LlmStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'refusal' | 'other';

export interface LlmResponse {
  readonly provider: string;
  /** The model that actually answered. */
  readonly model: string;
  readonly tier: LlmTier;
  readonly text: string;
  readonly usage: LlmUsage;
  readonly stopReason: LlmStopReason;
  readonly latencyMs: number;
  readonly providerRequestId: string | undefined;
  /** True when served from the completion cache: no tokens were consumed. */
  readonly cached: boolean;
}

export interface StructuredLlmResponse<T> extends LlmResponse {
  /** Validated against the caller's schema; never coerced. */
  readonly output: T;
}

export const LlmErrorKind = {
  /** No provider or no credentials are configured. */
  PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  /** DOLMIR built a request the provider (or the port) rejects. */
  INVALID_REQUEST: 'INVALID_REQUEST',
  /** The provider rejected DOLMIR's credentials or account. */
  AUTHENTICATION: 'AUTHENTICATION',
  RATE_LIMITED: 'RATE_LIMITED',
  /** Network, timeout, provider 5xx or overload. */
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  /** The model answered, but not in the shape that was asked for. */
  BAD_RESPONSE: 'BAD_RESPONSE',
  /** The model declined to answer. */
  REFUSED: 'REFUSED',
  /** Output stopped at the token limit before completing. */
  TRUNCATED: 'TRUNCATED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type LlmErrorKind = (typeof LlmErrorKind)[keyof typeof LlmErrorKind];

const KIND_META: Readonly<
  Record<LlmErrorKind, { readonly category: ErrorCategory; readonly retryable: boolean }>
> = {
  PROVIDER_NOT_CONFIGURED: { category: ErrorCategory.PRECONDITION_FAILED, retryable: false },
  INVALID_REQUEST: { category: ErrorCategory.VALIDATION, retryable: false },
  AUTHENTICATION: { category: ErrorCategory.INFRASTRUCTURE, retryable: false },
  RATE_LIMITED: { category: ErrorCategory.RATE_LIMITED, retryable: true },
  PROVIDER_UNAVAILABLE: { category: ErrorCategory.INFRASTRUCTURE, retryable: true },
  BAD_RESPONSE: { category: ErrorCategory.INFRASTRUCTURE, retryable: true },
  REFUSED: { category: ErrorCategory.PRECONDITION_FAILED, retryable: false },
  TRUNCATED: { category: ErrorCategory.PRECONDITION_FAILED, retryable: false },
  UNKNOWN: { category: ErrorCategory.INTERNAL, retryable: false },
};

/** What the provider did before a failure — so the cost of a failed call is still recorded. */
export interface LlmAttempt {
  readonly model: string;
  readonly usage: LlmUsage;
  readonly latencyMs: number;
  readonly providerRequestId: string | undefined;
}

export interface LlmErrorOptions extends Omit<DomainErrorOptions, 'retryable'> {
  readonly attempt?: LlmAttempt;
}

export class LlmError extends DomainError {
  readonly kind: LlmErrorKind;
  readonly attempt: LlmAttempt | undefined;

  constructor(kind: LlmErrorKind, message: string, options: LlmErrorOptions = {}) {
    const meta = KIND_META[kind];
    super(meta.category, `LLM_${kind}`, message, {
      retryable: meta.retryable,
      ...(options.details === undefined ? {} : { details: options.details }),
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.kind = kind;
    this.attempt = options.attempt;
  }
}

export interface LlmCapabilities {
  readonly structuredOutput: boolean;
  /** Image and document inputs. The request DTO does not carry them yet, so no adapter claims it. */
  readonly vision: boolean;
}

export interface LlmProviderPort {
  readonly name: string;
  readonly capabilities: LlmCapabilities;
  complete(request: LlmRequest): Promise<Result<LlmResponse, LlmError>>;
  completeStructured<T>(
    request: LlmRequest,
    schema: z.ZodType<T>,
  ): Promise<Result<StructuredLlmResponse<T>, LlmError>>;
}

/** Shared by every adapter, so an invalid request fails identically everywhere. */
export function checkLlmRequest(request: LlmRequest): Result<LlmRequest, LlmError> {
  const parsed = LlmRequestSchema.safeParse(request);
  if (!parsed.success) {
    return err(
      new LlmError('INVALID_REQUEST', 'The LLM request is invalid.', {
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            message: issue.message,
          })),
        },
      }),
    );
  }
  return ok(parsed.data);
}

/** Rough token estimate for fakes and pre-flight sizing; never billed. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
