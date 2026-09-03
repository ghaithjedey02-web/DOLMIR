import {
  type AiSystemDefinition,
  type AnalysisInput,
  type CaseDraftInput,
  type ConnectionId,
  type Document,
  type DomainError,
  type LlmTier,
  type Result,
  type SystemContext,
  err,
  ok,
} from '@dolmir/core';

import { HANDLED_INTENTS } from './domain/intent.js';
import { COMMERCIAL_INBOX_RULES, COMMERCIAL_INBOX_SYSTEM_KEY, readRules } from './domain/rules.js';
import type { EvidenceSource } from './domain/verified.js';
import { buildCaseDraft, type RecommendationDraft } from './analysis/case-draft.js';
import { assessCompleteness } from './analysis/completeness.js';
import {
  type DraftRequest,
  type DraftedReply,
  type ReplyDraft,
  draftReply as defaultDraftReply,
} from './analysis/draft.js';
import { resolveAnalysis } from './analysis/resolve.js';
import { understandMessage } from './analysis/understand.js';

/**
 * Commercial Inbox Intelligence: the first DOLMIR AI System (ADR-0012).
 *
 * It reads an inbound commercial message, identifies the counterpart and the
 * articles deterministically, states what is missing, and proposes at most one
 * reply for a human to approve. It stores nothing and executes nothing: Core
 * validates the draft, re-verifies every citation, applies the company's
 * action policy and runs an approved recommendation through the tool executor.
 *
 * It contributes no tool of its own. Replying through a mailbox is a platform
 * capability (`send_mailbox_reply`), shared with every other system.
 */
export const COMMERCIAL_INBOX_VERSION = 1;

export interface CommercialInboxOptions {
  /** Which mailbox a reply would go through. `null` means no reply can be proposed. */
  readonly resolveReplyConnection: (
    input: AnalysisInput,
    context: SystemContext,
  ) => Promise<ConnectionId | null>;
  /** Replaces the built-in drafting step. Tests use it; production does not. */
  readonly draftReply?: (
    request: DraftRequest,
    context: SystemContext,
  ) => Promise<Result<DraftedReply, DomainError>>;
  /** When false the system reads and explains but never proposes a reply. */
  readonly proposeReplies?: boolean;
  readonly understandTier?: LlmTier;
  readonly draftTier?: LlmTier;
}

export function createCommercialInboxSystem(options: CommercialInboxOptions): AiSystemDefinition {
  return {
    key: COMMERCIAL_INBOX_SYSTEM_KEY,
    name: 'Commercial Inbox Intelligence',
    version: COMMERCIAL_INBOX_VERSION,
    documentKinds: ['email'],
    tools: [],
    rules: COMMERCIAL_INBOX_RULES,
    async analyze(
      input: AnalysisInput,
      context: SystemContext,
    ): Promise<Result<CaseDraftInput | null, DomainError>> {
      const rules = readRules(input.company.rules);
      const sender = senderOf(input.document);
      if (sender.domain !== null && rules.ignoredSenderDomains.includes(sender.domain)) {
        context.logger.debug('sender domain is ignored by company rule', { domain: sender.domain });
        return ok(null);
      }

      const sources: EvidenceSource[] = [
        { documentId: input.document.id, label: 'email', texts: input.texts },
        ...input.children.map((child) => ({
          documentId: child.document.id,
          label: `attachment:${child.document.filename ?? String(child.document.id)}`,
          texts: child.texts,
        })),
      ];

      const understood = await understandMessage(
        context.llm,
        { tenantId: input.tenantId, sources, company: input.company },
        options.understandTier ?? 'standard',
      );
      if (!understood.ok) return err(understood.error);
      const understanding = understood.value.understanding;
      if (!HANDLED_INTENTS.has(understanding.intent)) {
        context.logger.debug('message is not commercial', { intent: understanding.intent });
        return ok(null);
      }

      const analysis = await resolveAnalysis(understanding, {
        scope: context.scope,
        entities: context.entities,
        sources,
        senderAddress: sender.address,
        senderDomain: sender.domain,
        dayFirst: understanding.language !== 'en',
        reference: input.document.receivedAt,
      });
      const completeness = assessCompleteness(analysis, rules);

      let recommendation: RecommendationDraft | null = null;
      let refusedDraft: DraftedReply['refused'] = null;
      const drafting =
        options.draftReply ??
        ((request, ctx) => defaultDraftReply(ctx.llm, request, ctx, options.draftTier ?? 'fast'));
      if (completeness.canRecommendReply && options.proposeReplies !== false) {
        const connectionId = await options.resolveReplyConnection(input, context);
        if (connectionId === null) {
          context.logger.info(
            'no mailbox connection to reply through; opening the case without one',
          );
        } else {
          const drafted = await drafting(
            {
              analysis,
              completeness,
              company: input.company,
              rules,
              tenantId: input.tenantId,
              inReplyTo: messageIdOf(input.document),
              references: referencesOf(input.document),
              recipients: sender.address === null ? [] : [sender.address],
              subject: subjectOf(input.document),
            },
            context,
          );
          if (!drafted.ok) return err(drafted.error);
          refusedDraft = drafted.value.refused;
          const draft = drafted.value.draft;
          if (draft !== null && sender.address !== null) {
            recommendation = {
              tool: 'send_mailbox_reply',
              input: {
                connectionId,
                to: [sender.address],
                subject: draft.subject,
                body: draft.body,
                ...(messageIdOf(input.document) === null
                  ? {}
                  : { inReplyTo: messageIdOf(input.document) }),
                references: referencesOf(input.document),
              },
              rationale: draft.rationale,
            };
          }
        }
      }

      return ok(
        buildCaseDraft({
          analysis,
          completeness,
          company: input.company,
          recommendation,
          refusedDraft,
        }),
      );
    },
  };
}

/** The sender as the transport reported it. A display name inside the body is never an identity. */
function senderOf(document: Document): {
  readonly address: string | null;
  readonly domain: string | null;
} {
  const from: unknown = document.metadata['from'];
  const address =
    typeof from === 'object' && from !== null && 'address' in from ? from.address : null;
  const domain = document.metadata['fromDomain'];
  return {
    address: typeof address === 'string' ? address : null,
    domain: typeof domain === 'string' ? domain : null,
  };
}

function messageIdOf(document: Document): string | null {
  const value = document.metadata['messageId'];
  return typeof value === 'string' ? value : null;
}

function subjectOf(document: Document): string | null {
  const value = document.metadata['subject'];
  return typeof value === 'string' ? value : null;
}

function referencesOf(document: Document): string[] {
  const value = document.metadata['references'];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').slice(0, 20);
}

export type { DraftRequest, ReplyDraft };
