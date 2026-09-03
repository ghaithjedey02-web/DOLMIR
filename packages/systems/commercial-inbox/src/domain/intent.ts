import type { CasePriority } from '@dolmir/core';

import type { CommercialIntent, Urgency } from './understanding.js';

/**
 * How an intent becomes a case. The kind is what an operator filters on; the
 * priority is a deliberate, deterministic function of intent and urgency, not
 * something the model sets.
 */
export const CASE_KIND_BY_INTENT: Readonly<Record<CommercialIntent, string>> = {
  quote_request: 'quote_request',
  order_request: 'order_request',
  order_change: 'order_change',
  customer_question: 'customer_question',
  complaint: 'complaint',
  follow_up: 'follow_up',
  information_request: 'information_request',
  supplier_message: 'supplier_message',
  other_commercial: 'other_commercial',
  not_commercial: 'not_commercial',
};

/** Intents that carry requested lines, and therefore need product and quantity to be complete. */
export const LINE_BEARING_INTENTS: ReadonlySet<CommercialIntent> = new Set<CommercialIntent>([
  'quote_request',
  'order_request',
  'order_change',
]);

/** Intents this system opens a case for. Anything else is not its business. */
export const HANDLED_INTENTS: ReadonlySet<CommercialIntent> = new Set<CommercialIntent>([
  'quote_request',
  'order_request',
  'order_change',
  'customer_question',
  'complaint',
  'follow_up',
  'information_request',
  'supplier_message',
  'other_commercial',
]);

/**
 * A complaint is never low, and rises with urgency. A message that asks for
 * goods is never low either, because a late answer loses the business. Only an
 * urgent message is high, so the high queue keeps meaning something.
 */
export function priorityFor(intent: CommercialIntent, urgency: Urgency): CasePriority {
  if (urgency === 'high') return 'high';
  if (intent === 'complaint') return urgency === 'low' ? 'normal' : 'high';
  if (LINE_BEARING_INTENTS.has(intent)) return 'normal';
  return urgency === 'low' ? 'low' : 'normal';
}
