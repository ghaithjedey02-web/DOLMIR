import {
  type Claim,
  type EntityResolution,
  type EntityResolver,
  EpistemicStatus,
  type Evidence,
  type TenantScope,
  claimForMatch,
} from '@dolmir/core';

import { parseDeliveryDate, parseQuantity, parseUnit } from '../domain/parsing.js';
import type { MessageUnderstanding } from '../domain/understanding.js';
import { type EvidenceSource, type VerifiedValue, verifyAndParse } from '../domain/verified.js';

/**
 * RESOLVE and the deterministic half of REASON. Every quotation the model
 * produced is checked against the document before it is parsed, and every
 * identity comes from the entity resolver rather than from the model. A
 * quotation that is not in the message is recorded as rejected: it never
 * becomes a value, and the case shows that the reading and the document
 * disagreed.
 */
export interface RejectedQuote {
  readonly field: string;
  readonly quote: string;
}

export interface ResolvedLine {
  readonly index: number;
  readonly description: VerifiedValue<string>;
  readonly productCode: VerifiedValue<string> | null;
  readonly product: EntityResolution;
  readonly quantity: VerifiedValue<number> | null;
  readonly unit: string | null;
  readonly deliveryDate: VerifiedValue<Date> | null;
}

export interface CommercialAnalysis {
  readonly understanding: MessageUnderstanding;
  /** From the message headers, never from the body: a display name is not an identity. */
  readonly senderAddress: string | null;
  readonly senderOrganisation: VerifiedValue<string> | null;
  readonly customer: EntityResolution;
  readonly lines: readonly ResolvedLine[];
  readonly deliveryDate: VerifiedValue<Date> | null;
  readonly requestedInformation: readonly VerifiedValue<string>[];
  readonly rejectedQuotes: readonly RejectedQuote[];
}

export interface ResolveInput {
  readonly scope: TenantScope;
  readonly entities: EntityResolver;
  readonly sources: readonly EvidenceSource[];
  readonly senderAddress: string | null;
  readonly senderDomain: string | null;
  /** Decides whether `03/04` is the third of April or the fourth of March. */
  readonly dayFirst: boolean;
  /** Used to infer a year the message left out. */
  readonly reference: Date;
}

export async function resolveAnalysis(
  understanding: MessageUnderstanding,
  input: ResolveInput,
): Promise<CommercialAnalysis> {
  const rejected: RejectedQuote[] = [];
  const keep = <T>(field: string, quote: string | null, value: VerifiedValue<T> | null) => {
    if (quote !== null && value === null) rejected.push({ field, quote });
    return value;
  };
  const dateOptions = { reference: input.reference, dayFirst: input.dayFirst };

  const senderOrganisation = keep(
    'senderOrganisationQuote',
    understanding.senderOrganisationQuote,
    verifyAndParse(input.sources, understanding.senderOrganisationQuote, (text) => text),
  );

  // Identity is resolved from the address the transport reports and, only as a
  // weaker signal, from a company name the message itself contains and that was
  // verified to be there.
  const customer = await input.entities.resolve(input.scope, {
    kind: 'customer',
    ...(input.senderAddress === null ? {} : { email: input.senderAddress }),
    ...(senderOrganisation === null ? {} : { name: senderOrganisation.value }),
  });

  const deliveryDate = keep(
    'deliveryDateQuote',
    understanding.deliveryDateQuote,
    verifyAndParse(input.sources, understanding.deliveryDateQuote, (text) =>
      parseDeliveryDate(text, dateOptions),
    ),
  );

  const lines: ResolvedLine[] = [];
  for (const [index, line] of understanding.lines.entries()) {
    const description = verifyAndParse(input.sources, line.descriptionQuote, (text) => text);
    if (description === null) {
      rejected.push({
        field: `lines[${String(index)}].descriptionQuote`,
        quote: line.descriptionQuote,
      });
      continue;
    }
    const productCode = keep(
      `lines[${String(index)}].productCodeQuote`,
      line.productCodeQuote,
      verifyAndParse(input.sources, line.productCodeQuote, (text) => text.trim()),
    );
    const quantity = keep(
      `lines[${String(index)}].quantityQuote`,
      line.quantityQuote,
      verifyAndParse(input.sources, line.quantityQuote, parseQuantity),
    );
    const unitQuote = keep(
      `lines[${String(index)}].unitQuote`,
      line.unitQuote,
      verifyAndParse(input.sources, line.unitQuote, (text) => text),
    );
    const lineDate = keep(
      `lines[${String(index)}].lineDeliveryDateQuote`,
      line.lineDeliveryDateQuote,
      verifyAndParse(input.sources, line.lineDeliveryDateQuote, (text) =>
        parseDeliveryDate(text, dateOptions),
      ),
    );
    const product = await input.entities.resolve(input.scope, {
      kind: 'product',
      name: description.value,
      ...(productCode === null ? {} : { code: productCode.value }),
    });
    lines.push({
      index,
      description,
      productCode,
      product,
      quantity,
      unit: parseUnit(unitQuote?.value ?? quantity?.quote ?? null),
      deliveryDate: lineDate ?? deliveryDate,
    });
  }

  const requestedInformation: VerifiedValue<string>[] = [];
  for (const asked of understanding.requestedInformation) {
    const verified = verifyAndParse(input.sources, asked, (text) => text);
    if (verified === null) rejected.push({ field: 'requestedInformation', quote: asked });
    else requestedInformation.push(verified);
  }

  return {
    understanding,
    senderAddress: input.senderAddress,
    senderOrganisation,
    customer,
    lines,
    deliveryDate,
    requestedInformation,
    rejectedQuotes: rejected,
  };
}

/** The claim identifying the counterpart, with the record fields that matched. */
export function customerClaim(analysis: CommercialAnalysis): Claim | null {
  return analysis.customer.kind === 'RESOLVED' ? claimForMatch(analysis.customer.match) : null;
}

/**
 * What the platform believes about one line, as a claim an operator can check.
 * It is an OBSERVATION, never a FACT: the message is what the customer wrote,
 * which is not the same as what is true.
 */
export function lineClaim(line: ResolvedLine): Claim {
  const parts = [
    line.quantity === null ? 'An unspecified quantity' : String(line.quantity.value),
    line.unit ?? '',
    `of "${line.description.value}"`,
    line.product.kind === 'RESOLVED'
      ? `(${line.product.match.entity.name})`
      : '(product not identified)',
    line.deliveryDate === null
      ? ''
      : `requested for ${line.deliveryDate.value.toISOString().slice(0, 10)}`,
  ].filter((part) => part.length > 0);
  const evidence: Evidence[] = [line.description.evidence];
  if (line.quantity !== null) evidence.push(line.quantity.evidence);
  if (line.productCode !== null) evidence.push(line.productCode.evidence);
  if (line.deliveryDate !== null) evidence.push(line.deliveryDate.evidence);
  if (line.product.kind === 'RESOLVED') {
    evidence.push(...claimForMatch(line.product.match).evidence);
  }
  return {
    statement: `The message asks for ${parts.join(' ')}`,
    status: EpistemicStatus.OBSERVATION,
    evidence,
  };
}
