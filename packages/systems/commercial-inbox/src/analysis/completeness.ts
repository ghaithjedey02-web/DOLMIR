import type { MissingInput } from '@dolmir/core';

import { LINE_BEARING_INTENTS } from '../domain/intent.js';
import type { CommercialInboxRules } from '../domain/rules.js';
import type { CommercialAnalysis } from './resolve.js';

/**
 * What is still needed before the company can act, decided by rules rather
 * than by a model. Two of these gaps are structural: without an identified
 * counterpart nothing may be sent anywhere, and a request for items with no
 * verified item is not a request DOLMIR can describe.
 */
export interface Completeness {
  readonly missing: readonly MissingInput[];
  /** False when the case is opened for a human to read, with nothing proposed. */
  readonly canRecommendReply: boolean;
  readonly determination: 'READY_FOR_REVIEW' | 'NON_DETERMINATO';
}

export function assessCompleteness(
  analysis: CommercialAnalysis,
  rules: CommercialInboxRules,
): Completeness {
  const missing: MissingInput[] = [];
  const intent = analysis.understanding.intent;
  const carriesLines = LINE_BEARING_INTENTS.has(intent);

  if (analysis.customer.kind !== 'RESOLVED') {
    missing.push({
      name: 'counterpart identity',
      description:
        analysis.customer.kind === 'AMBIGUOUS'
          ? 'Confirm which customer record the sender belongs to, or create a new one.'
          : 'Record the sender as a customer, or add their address or domain to an existing record.',
      resolvableBy: 'HUMAN',
    });
  }

  for (const line of analysis.lines) {
    const label = line.description.value;
    if (line.product.kind !== 'RESOLVED') {
      missing.push({
        name: `product for "${label}"`,
        description:
          line.product.kind === 'AMBIGUOUS'
            ? 'Confirm which article the customer means.'
            : 'Identify the article the customer means, or add it to the catalogue.',
        resolvableBy: 'HUMAN',
      });
    }
    if (line.quantity === null) {
      missing.push({
        name: `quantity for "${label}"`,
        description: 'Ask the customer how many units they need.',
        resolvableBy: 'EXTERNAL',
      });
    }
  }

  if (carriesLines && analysis.lines.length === 0) {
    missing.push({
      name: 'requested items',
      description: 'Ask the customer which articles and quantities the request covers.',
      resolvableBy: 'EXTERNAL',
    });
  }
  if (
    carriesLines &&
    analysis.deliveryDate === null &&
    analysis.lines.every((l) => l.deliveryDate === null)
  ) {
    missing.push({
      name: 'requested delivery date',
      description: 'Ask the customer by when they need the goods.',
      resolvableBy: 'EXTERNAL',
    });
  }

  const identified = analysis.customer.kind === 'RESOLVED';
  const describable = !carriesLines || analysis.lines.length > 0;
  const determination = identified && describable ? 'READY_FOR_REVIEW' : 'NON_DETERMINATO';
  // A company that does not want DOLMIR to acknowledge quotations still gets the
  // case, the findings and the evidence; it simply gets no proposed reply.
  const acknowledgementsAllowed =
    rules.acknowledgeQuoteRequests || !LINE_BEARING_INTENTS.has(intent);
  return {
    missing,
    determination,
    canRecommendReply:
      determination === 'READY_FOR_REVIEW' &&
      acknowledgementsAllowed &&
      (identified || !rules.requireKnownCustomer),
  };
}
