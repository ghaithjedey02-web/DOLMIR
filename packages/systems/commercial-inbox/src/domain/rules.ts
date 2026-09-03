import type { RuleDefinition } from '@dolmir/core';
import { z } from 'zod';

/**
 * Rules this system understands, registered into the shared registry so a
 * company can set them and see them versioned. Each one changes behaviour
 * deterministically; none of them is read from a message.
 */
export const COMMERCIAL_INBOX_SYSTEM_KEY = 'commercial_inbox';

export const RULE_KEYS = {
  ACKNOWLEDGE_QUOTE_REQUESTS: 'commercial_inbox.acknowledge_quote_requests',
  QUOTATION_LEAD_TIME_DAYS: 'commercial_inbox.quotation_lead_time_days',
  IGNORED_SENDER_DOMAINS: 'commercial_inbox.ignored_sender_domains',
  REQUIRE_KNOWN_CUSTOMER: 'commercial_inbox.require_known_customer',
} as const;

export const COMMERCIAL_INBOX_RULES: readonly RuleDefinition[] = [
  {
    key: RULE_KEYS.ACKNOWLEDGE_QUOTE_REQUESTS,
    description:
      'Whether DOLMIR proposes an acknowledgement reply for a request for quotation. When false it opens the case without a reply recommendation.',
    schema: z.boolean(),
    owner: COMMERCIAL_INBOX_SYSTEM_KEY,
  },
  {
    key: RULE_KEYS.QUOTATION_LEAD_TIME_DAYS,
    description:
      'Working days the company usually needs to return a quotation. Stated in an acknowledgement so the customer knows when to expect it.',
    schema: z.number().int().min(1).max(60),
    owner: COMMERCIAL_INBOX_SYSTEM_KEY,
  },
  {
    key: RULE_KEYS.IGNORED_SENDER_DOMAINS,
    description:
      'Sender domains this system never opens a case for, such as newsletters and internal notifications.',
    schema: z.array(z.string().trim().min(1).max(255)).max(200),
    owner: COMMERCIAL_INBOX_SYSTEM_KEY,
  },
  {
    key: RULE_KEYS.REQUIRE_KNOWN_CUSTOMER,
    description:
      'When true, a message from a counterpart DOLMIR cannot identify never carries a reply recommendation, whatever else is understood.',
    schema: z.boolean(),
    owner: COMMERCIAL_INBOX_SYSTEM_KEY,
  },
];

export interface CommercialInboxRules {
  readonly acknowledgeQuoteRequests: boolean;
  readonly quotationLeadTimeDays: number | null;
  readonly ignoredSenderDomains: readonly string[];
  readonly requireKnownCustomer: boolean;
  readonly replyLanguage: string | null;
  readonly responseSlaHours: number | null;
}

/** Reads the rule values a tenant set, with the defaults a company gets before it configures anything. */
export function readRules(values: Readonly<Record<string, unknown>>): CommercialInboxRules {
  const bool = (key: string, fallback: boolean): boolean =>
    typeof values[key] === 'boolean' ? values[key] : fallback;
  const int = (key: string): number | null =>
    typeof values[key] === 'number' && Number.isInteger(values[key]) ? values[key] : null;
  const text = (key: string): string | null =>
    typeof values[key] === 'string' && values[key].length > 0 ? values[key] : null;
  const list = (key: string): readonly string[] =>
    Array.isArray(values[key])
      ? values[key].filter((item): item is string => typeof item === 'string')
      : [];
  return {
    acknowledgeQuoteRequests: bool(RULE_KEYS.ACKNOWLEDGE_QUOTE_REQUESTS, true),
    quotationLeadTimeDays: int(RULE_KEYS.QUOTATION_LEAD_TIME_DAYS),
    ignoredSenderDomains: list(RULE_KEYS.IGNORED_SENDER_DOMAINS).map((item) =>
      item.trim().toLowerCase(),
    ),
    requireKnownCustomer: bool(RULE_KEYS.REQUIRE_KNOWN_CUSTOMER, false),
    replyLanguage: text('reply_language'),
    responseSlaHours: int('response_sla_hours'),
  };
}
