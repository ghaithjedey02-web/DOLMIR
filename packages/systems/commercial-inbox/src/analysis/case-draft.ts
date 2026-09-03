import {
  type CaseDraftInput,
  type Claim,
  type CompanyContext,
  EpistemicStatus,
  type Evidence,
  type NonDeterminato,
  type SubjectRef,
  nonDeterminato,
  resolutionToDetermination,
} from '@dolmir/core';

import { CASE_KIND_BY_INTENT, priorityFor } from '../domain/intent.js';
import type { Completeness } from './completeness.js';
import { type CommercialAnalysis, customerClaim, lineClaim } from './resolve.js';

/**
 * What the system hands to Core. Declarative: findings with their evidence,
 * an honest determination, and at most one recommendation. Core validates it,
 * re-verifies every cited span, resolves the policy level and stores the case.
 */
export interface RecommendationDraft {
  readonly tool: string;
  readonly input: unknown;
  readonly rationale: string;
}

export interface CaseDraftInputs {
  readonly analysis: CommercialAnalysis;
  readonly completeness: Completeness;
  readonly company: CompanyContext;
  readonly recommendation: RecommendationDraft | null;
}

export function buildCaseDraft(inputs: CaseDraftInputs): CaseDraftInput {
  const { analysis, completeness } = inputs;
  const understanding = analysis.understanding;
  const findings: (Claim & { tags: string[] })[] = [];

  const identity = customerClaim(analysis);
  if (identity !== null) findings.push({ ...identity, tags: ['counterpart'] });

  for (const line of analysis.lines) {
    findings.push({ ...lineClaim(line), tags: ['requested_line'] });
  }

  if (analysis.deliveryDate !== null && analysis.lines.length === 0) {
    findings.push({
      statement: `The message asks for delivery by ${analysis.deliveryDate.value
        .toISOString()
        .slice(0, 10)}`,
      status: EpistemicStatus.OBSERVATION,
      evidence: [analysis.deliveryDate.evidence],
      tags: ['delivery_date'],
    });
  }

  for (const asked of analysis.requestedInformation) {
    findings.push({
      statement: `The sender asks for: ${asked.value}`,
      status: EpistemicStatus.OBSERVATION,
      evidence: [asked.evidence],
      tags: ['requested_information'],
    });
  }

  if (understanding.containsInstructionsToAssistant) {
    findings.push({
      statement:
        'The message contains text addressed to an automated assistant. It was read as content and changed nothing: DOLMIR takes instructions only from the company configuration and from authorised people.',
      status: EpistemicStatus.OBSERVATION,
      evidence: observationEvidence(analysis, 'instructions addressed to an assistant'),
      tags: ['prompt_injection'],
    });
  }

  if (analysis.rejectedQuotes.length > 0) {
    findings.push({
      statement: `${String(analysis.rejectedQuotes.length)} value(s) the reading proposed were not found in the message and were discarded: ${analysis.rejectedQuotes
        .map((item) => `${item.field} ("${item.quote.slice(0, 60)}")`)
        .join('; ')}`,
      status: EpistemicStatus.OBSERVATION,
      evidence: observationEvidence(analysis, 'quotations that did not verify'),
      tags: ['unverified_reading'],
    });
  }

  const subjects: SubjectRef[] = [];
  if (analysis.customer.kind === 'RESOLVED') {
    subjects.push({
      type: 'customer',
      id: analysis.customer.match.entity.id,
      label: analysis.customer.match.entity.name,
    });
  }
  for (const line of analysis.lines) {
    if (line.product.kind === 'RESOLVED') {
      subjects.push({
        type: 'product',
        id: line.product.match.entity.id,
        label: line.product.match.entity.name,
      });
    }
  }

  const counterpart =
    analysis.customer.kind === 'RESOLVED'
      ? analysis.customer.match.entity.name
      : (analysis.senderOrganisation?.value ?? analysis.senderAddress ?? 'an unidentified sender');

  return {
    kind: CASE_KIND_BY_INTENT[understanding.intent],
    title: `${titleFor(understanding.intent)}: ${counterpart}`.slice(0, 300),
    summary: understanding.summary,
    priority: priorityFor(understanding.intent, understanding.urgency),
    determination: completeness.determination,
    ...(completeness.determination === 'NON_DETERMINATO'
      ? { nonDeterminato: buildNonDeterminato(analysis, completeness, findings) }
      : {}),
    subjects,
    findings,
    recommendations: inputs.recommendation === null ? [] : [inputs.recommendation],
  };
}

/** A claim carries no tags; those belong to the finding the case stores. */
function asClaim(finding: Claim & { tags: string[] }): Claim {
  return { statement: finding.statement, status: finding.status, evidence: finding.evidence };
}

const TITLES: Readonly<Record<string, string>> = {
  quote_request: 'Richiesta di preventivo',
  order_request: 'Ordine',
  order_change: 'Modifica ordine',
  customer_question: 'Domanda cliente',
  complaint: 'Reclamo',
  follow_up: 'Sollecito',
  information_request: 'Richiesta di informazioni',
  supplier_message: 'Messaggio fornitore',
  other_commercial: 'Messaggio commerciale',
  not_commercial: 'Messaggio',
};

function titleFor(intent: string): string {
  return TITLES[intent] ?? 'Messaggio commerciale';
}

/**
 * The honest account when the case cannot be concluded. An unidentified
 * counterpart reuses the resolver's own account, so the candidates and the
 * decision a human must take are stated the same way everywhere.
 */
function buildNonDeterminato(
  analysis: CommercialAnalysis,
  completeness: Completeness,
  findings: readonly (Claim & { tags: string[] })[],
): NonDeterminato {
  if (analysis.customer.kind !== 'RESOLVED') {
    const determination = resolutionToDetermination(
      analysis.customer,
      `the counterpart of the message from ${analysis.senderAddress ?? 'an unknown address'}`,
    );
    if (determination.kind === 'NON_DETERMINATO') {
      return {
        ...determination,
        known: [...determination.known, ...findings.map(asClaim)],
        missingInputs: [...completeness.missing],
      };
    }
  }
  const built = nonDeterminato({
    subject: 'what the message asks for',
    known: findings.map(asClaim),
    unknown: ['Which articles and quantities the request covers'],
    missingInputs: [...completeness.missing],
    requiredHumanDecision: {
      question: 'Read the message and decide how to answer it.',
      options: [],
    },
  });
  if (!built.ok) throw built.error;
  return built.value;
}

/**
 * Evidence for a statement about the reading itself. It cites the message as a
 * whole, because the claim is about the analysis rather than about a span.
 */
function observationEvidence(analysis: CommercialAnalysis, what: string): Evidence[] {
  const first = analysis.lines[0]?.description.evidence;
  return [
    {
      kind: 'OBSERVATION',
      sourceRef: `analysis:commercial_inbox:${analysis.senderAddress ?? 'unknown'}`,
      content: what,
      ...(first === undefined ? {} : { locator: { relatedTo: first.sourceRef } }),
    },
  ];
}
