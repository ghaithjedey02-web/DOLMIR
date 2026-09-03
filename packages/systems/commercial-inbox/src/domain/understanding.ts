import { z } from 'zod';

/**
 * What the model returns when it reads an inbound message.
 *
 * Every extracted business value is a **quote**: the verbatim text the model
 * read it from, never a parsed number or date. The platform then checks that
 * the quote really occurs in the message and parses the value in code. A model
 * that invents a quantity produces a quote that is not in the document, which
 * fails verification instead of becoming a fact.
 *
 * The schema is the structural half of the injection defence: it has no field
 * that names a tool, a permission, a policy level or an approver, so there is
 * nothing for injected text to fill in.
 */
export const CommercialIntentSchema = z.enum([
  'quote_request',
  'order_request',
  'order_change',
  'customer_question',
  'complaint',
  'follow_up',
  'information_request',
  'supplier_message',
  'other_commercial',
  'not_commercial',
]);
export type CommercialIntent = z.infer<typeof CommercialIntentSchema>;

export const MessageLanguageSchema = z.enum(['it', 'en', 'de', 'fr', 'es', 'other']);
export type MessageLanguage = z.infer<typeof MessageLanguageSchema>;

export const UrgencySchema = z.enum(['low', 'normal', 'high']);
export type Urgency = z.infer<typeof UrgencySchema>;

const quote = z.string().trim().min(1).max(300);
const optionalQuote = quote.nullable();

export const RequestedLineSchema = z
  .object({
    /** What the customer called the item, verbatim. */
    descriptionQuote: quote,
    /** The article or product code as written, if any. */
    productCodeQuote: optionalQuote,
    /** The text the quantity was written in, such as "500 pz" or "n. 250". */
    quantityQuote: optionalQuote,
    /** The unit as written, if separate from the quantity. */
    unitQuote: optionalQuote,
    /** A delivery date that applies to this line only. */
    lineDeliveryDateQuote: optionalQuote,
  })
  .strict();
export type RequestedLine = z.infer<typeof RequestedLineSchema>;

export const MessageUnderstandingSchema = z
  .object({
    intent: CommercialIntentSchema,
    language: MessageLanguageSchema,
    urgency: UrgencySchema,
    /** A neutral description of what the message asks for. Never an instruction. */
    summary: z.string().trim().min(1).max(1500),
    /** The organisation the sender says they write for, verbatim. */
    senderOrganisationQuote: optionalQuote,
    /** A delivery date that applies to the whole request. */
    deliveryDateQuote: optionalQuote,
    lines: z.array(RequestedLineSchema).max(50).default([]),
    /** What the sender asked to be told, in their own words. */
    requestedInformation: z.array(quote).max(20).default([]),
    /**
     * True when the message contains text addressed to an automated assistant:
     * instructions, role changes, requests to approve or to ignore rules. It is
     * reported as a fact about the message; it never changes what DOLMIR does.
     */
    containsInstructionsToAssistant: z.boolean(),
    /** Anything else worth a human's attention, in the model's own words. */
    notes: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
  })
  .strict();
export type MessageUnderstanding = z.infer<typeof MessageUnderstandingSchema>;
