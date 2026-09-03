import type { Clock } from '../../../kernel/clock.js';
import type { DomainError } from '../../../kernel/errors.js';
import type { OrganizationId } from '../../../kernel/ids.js';
import type { Logger } from '../../../kernel/logger.js';
import type { Result } from '../../../kernel/result.js';
import type { TenantScope } from '../../../kernel/scope.js';
import type { AnyToolDefinition, LlmProviderPort } from '../../../ai/index.js';
import type { Document, DocumentText } from '../../documents/index.js';
import type { EntityResolver } from '../../entities/index.js';
import type { CompanyContext, RuleDefinition } from '../../workspace/index.js';
import type { CaseDraftInput } from '../domain/case.js';

/**
 * The contract every AI System implements (ADR-0012 §2). A system looks at a
 * document with the company's context and returns a declarative case draft,
 * or `null` when the document is not for it. It never stores anything and
 * never executes anything: Core validates, records, applies policy and runs
 * approved actions through the tool executor.
 */
export interface DocumentWithText {
  readonly document: Document;
  readonly texts: readonly DocumentText[];
}

export interface AnalysisInput {
  readonly tenantId: OrganizationId;
  readonly document: Document;
  readonly texts: readonly DocumentText[];
  /** Attachments (or other children) with their texts. */
  readonly children: readonly DocumentWithText[];
  readonly company: CompanyContext;
}

export interface SystemContext {
  readonly scope: TenantScope;
  readonly llm: LlmProviderPort;
  readonly entities: EntityResolver;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface AiSystemDefinition {
  /** `snake_case`; recorded on every case it produces. */
  readonly key: string;
  readonly name: string;
  /** Bumped whenever behaviour changes; recorded on every case. */
  readonly version: number;
  /** Document kinds the system wants to see (top-level documents only). */
  readonly documentKinds: readonly Document['kind'][];
  /** Tools the system contributes to the shared registry (its act tools among them). */
  readonly tools: readonly AnyToolDefinition[];
  /** Company rules the system understands. */
  readonly rules: readonly RuleDefinition[];
  analyze(
    input: AnalysisInput,
    context: SystemContext,
  ): Promise<Result<CaseDraftInput | null, DomainError>>;
}
