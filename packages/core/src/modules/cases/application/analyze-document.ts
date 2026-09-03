import type { Clock } from '../../../kernel/clock.js';
import {
  type DomainError,
  NotFoundError,
  PreconditionFailedError,
} from '../../../kernel/errors.js';
import type { DocumentId, OrganizationId } from '../../../kernel/ids.js';
import { type Logger, noopLogger } from '../../../kernel/logger.js';
import { err, ok, type Result } from '../../../kernel/result.js';
import type { TenantScope, TransactionRunner } from '../../../kernel/scope.js';
import type { LlmProviderPort } from '../../../ai/index.js';
import type { DocumentRepository, DocumentTextRepository } from '../../documents/index.js';
import type { EntityResolver } from '../../entities/index.js';
import type { OrganizationRepository } from '../../tenancy/index.js';
import type { WorkspaceConfiguration } from '../../workspace/index.js';
import type { AnalysisInput, DocumentWithText, SystemContext } from './ai-system.js';
import type { AiSystemRegistry } from './ai-system-registry.js';
import { type CaseEngine, type OpenedCase } from './case-engine.js';
import type { CaseRepository } from './ports.js';

/**
 * UNDERSTAND → RESOLVE → REASON → EVIDENCE → RECOMMEND for one document: every
 * registered system that wants this document kind analyses it with the
 * company context, and each draft becomes a case through the engine. Runs
 * once per (document, system): a re-run finds the existing case and skips.
 * AUTO_EXECUTE recommendations are executed right after the case is opened.
 */
export interface AnalyzeDocumentDependencies {
  readonly transactions: TransactionRunner;
  readonly documents: DocumentRepository;
  readonly texts: DocumentTextRepository;
  readonly organizations: OrganizationRepository;
  readonly workspace: WorkspaceConfiguration;
  readonly systems: AiSystemRegistry;
  readonly cases: CaseRepository;
  readonly engine: CaseEngine;
  readonly llm: LlmProviderPort;
  readonly entities: EntityResolver;
  readonly clock: Clock;
  readonly logger?: Logger;
}

export interface AnalysisReport {
  readonly documentId: DocumentId;
  readonly opened: readonly OpenedCase[];
  /** Systems that returned null (not for them) or already had a case. */
  readonly skipped: readonly {
    readonly systemKey: string;
    readonly reason: 'not_applicable' | 'already_analyzed';
  }[];
  readonly failed: readonly { readonly systemKey: string; readonly error: string }[];
}

export class AnalyzeDocument {
  private readonly deps: AnalyzeDocumentDependencies;
  private readonly logger: Logger;

  constructor(deps: AnalyzeDocumentDependencies) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
  }

  async execute(
    tenantId: OrganizationId,
    documentId: DocumentId,
  ): Promise<Result<AnalysisReport, DomainError>> {
    const loaded = await this.deps.transactions.withTenant(tenantId, async (scope) =>
      this.load(scope, tenantId, documentId),
    );
    if (!loaded.ok) return loaded;
    const { input, systems, alreadyAnalyzed } = loaded.value;

    const opened: OpenedCase[] = [];
    const skipped: { systemKey: string; reason: 'not_applicable' | 'already_analyzed' }[] =
      alreadyAnalyzed.map((systemKey) => ({ systemKey, reason: 'already_analyzed' as const }));
    const failed: { systemKey: string; error: string }[] = [];

    for (const system of systems) {
      const draft = await this.deps.transactions.withTenant(tenantId, (scope) =>
        system.analyze(input, {
          scope,
          llm: this.deps.llm,
          entities: this.deps.entities,
          clock: this.deps.clock,
          logger: this.logger.child({ system: system.key }),
        }),
      );
      if (!draft.ok) {
        this.logger.warn('system analysis failed', { system: system.key, code: draft.error.code });
        failed.push({ systemKey: system.key, error: draft.error.code });
        continue;
      }
      if (draft.value === null) {
        skipped.push({ systemKey: system.key, reason: 'not_applicable' });
        continue;
      }
      const subjects = [
        { type: 'document', id: documentId, label: input.document.filename ?? input.document.kind },
        ...(draft.value.subjects ?? []),
      ];
      const result = await this.deps.engine.openCase(
        tenantId,
        { ...draft.value, subjects },
        {
          systemKey: system.key,
          systemVersion: system.version,
          sourceRef: input.document.sourceRef,
          evidenceRefs: [`document:${documentId}`],
        },
      );
      if (!result.ok) {
        this.logger.warn('case could not be opened', {
          system: system.key,
          code: result.error.code,
        });
        failed.push({ systemKey: system.key, error: result.error.code });
        continue;
      }
      opened.push(result.value);
      for (const recommendation of result.value.recommendations) {
        if (recommendation.level === 'AUTO_EXECUTE') {
          const executed = await this.deps.engine.execute(tenantId, recommendation.id);
          if (!executed.ok) {
            this.logger.warn('auto-execution failed', {
              recommendationId: recommendation.id,
              code: executed.error.code,
            });
          }
        }
      }
    }
    return ok({ documentId, opened, skipped, failed });
  }

  private async load(
    scope: TenantScope,
    tenantId: OrganizationId,
    documentId: DocumentId,
  ): Promise<
    Result<
      {
        input: AnalysisInput;
        systems: ReturnType<AiSystemRegistry['forDocument']>;
        alreadyAnalyzed: string[];
      },
      DomainError
    >
  > {
    const document = await this.deps.documents.findById(scope, documentId);
    if (document === undefined)
      return err(new NotFoundError('DOCUMENT_NOT_FOUND', 'The document was not found.'));
    if (document.parentId !== null) {
      return err(
        new PreconditionFailedError(
          'NOT_A_TOP_LEVEL_DOCUMENT',
          'Attachments are analysed with their parent document.',
        ),
      );
    }
    const texts = await this.deps.texts.listByDocument(scope, documentId);
    const childDocuments = await this.deps.documents.listChildren(scope, documentId);
    const children: DocumentWithText[] = [];
    for (const child of childDocuments) {
      children.push({
        document: child,
        texts: await this.deps.texts.listByDocument(scope, child.id),
      });
    }
    const organization = await this.deps.organizations.findById(scope, tenantId);
    const company = await this.deps.workspace.context(scope, organization?.name ?? 'the company');
    const candidates = this.deps.systems.forDocument(document.kind);
    const systems: (typeof candidates)[number][] = [];
    const alreadyAnalyzed: string[] = [];
    for (const system of candidates) {
      const existing = await this.deps.cases.findCasesForDocument(scope, documentId, system.key);
      if (existing.length > 0) alreadyAnalyzed.push(system.key);
      else systems.push(system);
    }
    return ok({
      input: { tenantId, document, texts, children, company },
      systems,
      alreadyAnalyzed,
    });
  }
}

export type { SystemContext };
