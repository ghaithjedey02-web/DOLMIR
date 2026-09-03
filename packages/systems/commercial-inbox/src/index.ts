/**
 * Commercial Inbox Intelligence — the first DOLMIR AI System.
 * Depends only on the public surface of `@dolmir/core`.
 */
export {
  COMMERCIAL_INBOX_VERSION,
  type CommercialInboxOptions,
  type DraftRequest,
  type ReplyDraft,
  createCommercialInboxSystem,
} from './system.js';
export {
  COMMERCIAL_INBOX_RULES,
  COMMERCIAL_INBOX_SYSTEM_KEY,
  type CommercialInboxRules,
  RULE_KEYS,
  readRules,
} from './domain/rules.js';
export {
  CASE_KIND_BY_INTENT,
  HANDLED_INTENTS,
  LINE_BEARING_INTENTS,
  priorityFor,
} from './domain/intent.js';
export {
  type CommercialIntent,
  type MessageLanguage,
  type MessageUnderstanding,
  MessageUnderstandingSchema,
  type RequestedLine,
  type Urgency,
} from './domain/understanding.js';
export { numericTokens, parseDeliveryDate, parseQuantity, parseUnit } from './domain/parsing.js';
export {
  type EvidenceSource,
  type VerifiedValue,
  verifyAndParse,
  verifyQuote,
} from './domain/verified.js';
export { type Completeness, assessCompleteness } from './analysis/completeness.js';
export {
  type CommercialAnalysis,
  type RejectedQuote,
  type ResolvedLine,
  resolveAnalysis,
} from './analysis/resolve.js';
export { UNDERSTAND_OPERATION, understandMessage } from './analysis/understand.js';
export {
  type CaseDraftInputs,
  type RecommendationDraft,
  buildCaseDraft,
} from './analysis/case-draft.js';
