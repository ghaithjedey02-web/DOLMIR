import { describe, expect, it } from 'vitest';

import type { CompanyContext } from '@dolmir/core';

import type { CommercialInboxRules } from '../domain/rules.js';
import {
  type ClaimViolationKind,
  buildGroundedFacts,
  findDateClaims,
  groundDraft,
  normaliseClaimUnit,
} from './claims.js';
import { type DraftRequest, buildBrief } from './draft.js';
import type { CommercialAnalysis } from './resolve.js';

/**
 * The real RFQ, as the deterministic half of the pipeline resolved it:
 *
 *   500 pieces of FL-250 / "flangia tornita S355 DN250 PN16"
 *   requested for the 15th of October 2026 (the year inferred from receipt)
 *   from Officine Meccaniche Rossi S.r.l.
 *
 * Every adversarial case is written against exactly these facts, so a refusal
 * is never an artefact of a thinner fact base than production has.
 */
const DELIVERY = new Date('2026-10-15T00:00:00.000Z');
const EVIDENCE = { kind: 'DOCUMENT_SPAN', sourceRef: 'document:x', content: '', locator: {} };
const verified = <T>(value: T, quote = String(value)) => ({
  value,
  quote,
  evidence: EVIDENCE,
  source: 'email',
});

function analysisWith(patch: Partial<Record<string, unknown>> = {}): CommercialAnalysis {
  return {
    understanding: { intent: 'quote_request', language: 'it' },
    lines: [
      {
        index: 0,
        description: verified('flangia tornita S355 DN250 PN16'),
        productCode: verified('FL-250'),
        product: {
          kind: 'RESOLVED',
          match: { entity: { name: 'Flangia tornita S355 DN250 PN16', code: 'FL-250' } },
        },
        quantity: verified(500, '500 pezzi'),
        unit: 'pcs',
        deliveryDate: verified(DELIVERY, '15 ottobre'),
      },
    ],
    deliveryDate: verified(DELIVERY, '15 ottobre'),
    requestedInformation: [verified("Potete confermarci la fattibilita' e i tempi di consegna?")],
    senderOrganisation: null,
    customer: {
      kind: 'RESOLVED',
      match: { entity: { name: 'Officine Meccaniche Rossi S.r.l.', code: 'C0042' } },
    },
    rejectedQuotes: [],
    ...patch,
  } as unknown as CommercialAnalysis;
}

const SIGNATURE = 'Ufficio Commerciale\nAlfa Meccanica S.r.l.\nvendite@alfa-meccanica.it';

const company = {
  profile: {
    legalName: 'Alfa Meccanica S.r.l.',
    sector: 'Lavorazioni meccaniche di precisione',
    signature: SIGNATURE,
  },
  rules: {},
  terminology: [{ term: 'RdO', meaning: 'Richiesta di offerta.' }],
} as unknown as CompanyContext;

function rulesWith(patch: Partial<CommercialInboxRules> = {}): CommercialInboxRules {
  return {
    acknowledgeQuoteRequests: true,
    quotationLeadTimeDays: 3,
    quotationCustomerCommitmentDays: null,
    ignoredSenderDomains: [],
    requireKnownCustomer: false,
    replyLanguage: 'it',
    responseSlaHours: 24,
    ...patch,
  };
}

function factsFor(rules: CommercialInboxRules, analysis = analysisWith()) {
  const request = {
    analysis,
    completeness: { missing: [] },
    company,
    rules,
  } as unknown as DraftRequest;
  const brief = buildBrief(analysis, request, company, rules);
  return { brief, facts: buildGroundedFacts(brief, company) };
}

/** The company has promised its counterparts three working days. */
const committed = factsFor(rulesWith({ quotationCustomerCommitmentDays: 3 }));
/** The company plans on three working days internally and has promised nothing. */
const internalOnly = factsFor(rulesWith());

const check = (text: string, ground = committed.facts): ClaimViolationKind[] =>
  groundDraft(text, ground).map((violation) => violation.kind);
const report = (text: string, ground = committed.facts): string =>
  groundDraft(text, ground)
    .map((violation) => `${violation.kind}:${violation.token}`)
    .join(' | ');

describe('the brief carries provenance for every business value', () => {
  it('marks verified message prose as document evidence, not as trusted structure', () => {
    const line = committed.brief.requestedLines[0];
    expect(line?.requestedAs).toEqual({
      value: 'flangia tornita S355 DN250 PN16',
      source: 'document_evidence',
      ref: 'line:0.description',
    });
    expect(line?.quantity).toMatchObject({ value: 500, source: 'document_evidence' });
    expect(line?.article).toMatchObject({
      value: 'Flangia tornita S355 DN250 PN16',
      source: 'entity_record',
    });
    expect(committed.brief.counterpart).toMatchObject({ source: 'entity_record' });
    expect(committed.brief.company.legalName).toMatchObject({ source: 'company_profile' });
  });

  it('never puts the company signature or the internal lead time in front of the writer', () => {
    const json = JSON.stringify(internalOnly.brief);
    expect(json).not.toContain('Ufficio Commerciale');
    expect(json).not.toContain('quotationLeadTime');
    expect(internalOnly.brief.nextStep).toEqual({
      kind: 'internal_review',
      say: 'Vi daremo riscontro dopo la valutazione interna.',
    });
  });

  it('offers a deadline only when the company configured a customer-facing one', () => {
    expect(committed.brief.nextStep).toEqual({
      kind: 'commitment',
      workingDays: {
        value: 3,
        source: 'company_rule',
        ref: 'rule:commercial_inbox.quotation_customer_commitment_days',
      },
    });
  });
});

describe('the fact base', () => {
  it('keeps a quantity together with its unit', () => {
    expect(committed.facts.measurements).toContainEqual({
      value: 500,
      unit: 'pcs',
      source: 'document_evidence',
      ref: 'line:0.quantity',
    });
  });

  it('grounds a duration only from a customer-facing commitment', () => {
    expect(committed.facts.measurements).toContainEqual({
      value: 3,
      unit: 'working_day',
      source: 'company_rule',
      ref: 'rule:commercial_inbox.quotation_customer_commitment_days',
    });
    expect(internalOnly.facts.measurements.some((fact) => fact.unit === 'working_day')).toBe(false);
  });

  it('records the requested date, and grounds names from the record and the profile', () => {
    expect(committed.facts.dates).toContainEqual({
      iso: '2026-10-15',
      source: 'document_evidence',
      ref: 'line:0.deliveryDate',
    });
    expect(committed.facts.words.has('flangia')).toBe(true);
    expect(committed.facts.words.has('rossi')).toBe(true);
    expect(committed.facts.words.has('commerciale')).toBe(true);
    expect(committed.facts.words.has('tecnico')).toBe(false);
    expect(committed.facts.emails.has('vendite@alfa-meccanica.it')).toBe(true);
  });
});

describe('unit and date reading', () => {
  it('tells working days apart from days, weeks, months and per cent', () => {
    expect(normaliseClaimUnit('giorni lavorativi')).toBe('working_day');
    expect(normaliseClaimUnit('giorni')).toBe('day');
    expect(normaliseClaimUnit('settimane')).toBe('week');
    expect(normaliseClaimUnit('mesi')).toBe('month');
    expect(normaliseClaimUnit('%')).toBe('percent');
    expect(normaliseClaimUnit('pezzi')).toBe('pcs');
    expect(normaliseClaimUnit('pz')).toBe('pcs');
    expect(normaliseClaimUnit('kg')).toBe('kg');
  });

  it('finds a date however it is written', () => {
    expect(findDateClaims('entro il 15 ottobre 2026')[0]).toMatchObject({
      day: 15,
      month: 10,
      year: 2026,
    });
    expect(findDateClaims('entro il 15 ottobre')[0]).toMatchObject({
      day: 15,
      month: 10,
      year: null,
    });
    expect(findDateClaims('15/10/2026')[0]).toMatchObject({ day: 15, month: 10, year: 2026 });
    expect(findDateClaims('2026-10-15')[0]).toMatchObject({ day: 15, month: 10, year: 2026 });
  });
});

describe('grounded drafts are accepted', () => {
  it('accepts the reply the real RFQ should produce', () => {
    const body = [
      'Buongiorno,',
      '',
      'abbiamo ricevuto la vostra richiesta per 500 pz di FL-250, flangia tornita S355 DN250 PN16,',
      'con consegna richiesta entro il 15 ottobre 2026.',
      '',
      'Vi invieremo il preventivo entro 3 giorni lavorativi.',
      '',
      'Cordiali saluti',
    ].join('\n');
    expect(report(body)).toBe('');
  });

  it('accepts the same facts in different natural-language wording', () => {
    for (const body of [
      'Confermiamo la ricezione della richiesta di 500 pezzi.',
      "La quantita' richiesta e' di 500 pz.",
      'Consegna richiesta: 15/10/2026.',
      'Consegna richiesta: 2026-10-15.',
      "Il preventivo seguira' entro 3 giorni lavorativi.",
      'Our quotation will follow within 3 working days.',
      'Nel 2026 la consegna richiesta cade il 15 ottobre.',
      'Vi ringraziamo per la richiesta e vi risponderemo al piu presto.',
    ]) {
      expect(`${body} -> ${report(body)}`).toBe(`${body} -> `);
    }
  });

  it('accepts the counterpart, the article and the company by name', () => {
    const body =
      "Gentile Officine Meccaniche Rossi S.r.l., la flangia tornita S355 DN250 PN16 e' a riferimento presso Alfa Meccanica S.r.l.";
    expect(report(body)).toBe('');
  });

  it('accepts the safe wording when no deadline is authorised', () => {
    expect(report('Vi daremo riscontro dopo la valutazione interna.', internalOnly.facts)).toBe('');
  });
});

describe('the internal lead time is not a customer commitment', () => {
  const promise = "Vi comunicheremo l'offerta completa entro 3 giorni lavorativi.";

  it('refuses the promise when only the internal expectation is configured', () => {
    expect(check(promise, internalOnly.facts)).toContain('unverified_measurement');
  });

  it('accepts the same promise once the company configures the commitment', () => {
    expect(report(promise)).toBe('');
  });

  it('refuses any invented deadline even when a commitment exists', () => {
    expect(check('Offerta completa entro 2 giorni lavorativi.')).toContain(
      'unverified_measurement',
    );
    expect(check('Offerta completa entro 3 settimane.')).toContain('unverified_measurement');
    expect(check('Offerta completa entro 3 mesi.')).toContain('unverified_measurement');
    expect(check('Offerta completa entro 3 giorni.')).toContain('unverified_measurement');
  });

  it('refuses a deadline of any kind when none is authorised', () => {
    for (const text of [
      'Vi risponderemo entro 3 giorni lavorativi.',
      'Vi risponderemo entro 5 giorni.',
      'Riscontro entro il 20/09/2026.',
    ]) {
      expect(check(text, internalOnly.facts).length).toBeGreaterThan(0);
    }
  });
});

describe('factual prose needs evidence, whatever its case', () => {
  const claim = 'La richiesta riguarda un nuovo impianto.';

  it('refuses "nuovo impianto" when nothing in the message supports it', () => {
    expect(check(claim)).toContain('unverified_wording');
    expect(report(claim)).toContain('unverified_wording:impianto');
  });

  it('accepts "nuovo impianto" once it is verified document evidence', () => {
    const supported = factsFor(
      rulesWith({ quotationCustomerCommitmentDays: 3 }),
      analysisWith({
        requestedInformation: [
          verified("Potete confermarci la fattibilita' e i tempi di consegna?"),
          verified('per un nuovo impianto'),
        ],
      }),
    );
    expect(report(claim, supported.facts)).toBe('');
    // And it is evidence, not trusted structure: the source says where it came from.
    expect(supported.brief.requestedInformation.at(-1)).toMatchObject({
      value: 'per un nuovo impianto',
      source: 'document_evidence',
    });
  });

  it('refuses unsupported factual prose that carries no number and no capital', () => {
    for (const text of [
      'Il materiale e’ disponibile a magazzino.',
      'La produzione avviene nel nostro stabilimento.',
      'Applichiamo le condizioni del contratto quadro.',
      'Siamo in possesso della certificazione richiesta.',
      'Possiamo garantire la fornitura nei tempi indicati.',
    ]) {
      expect(`${text} -> ${check(text).join(',')}`).toContain('unverified_wording');
    }
  });

  it('accepts supported factual prose written in several ways', () => {
    const supported = factsFor(
      rulesWith({ quotationCustomerCommitmentDays: 3 }),
      analysisWith({
        requestedInformation: [verified('per un nuovo impianto di verniciatura')],
      }),
    );
    for (const text of [
      'Abbiamo ricevuto la richiesta per un nuovo impianto di verniciatura.',
      'Si tratta di un impianto nuovo.',
      'La verniciatura del nuovo impianto e’ il riferimento della richiesta.',
    ]) {
      expect(`${text} -> ${report(text, supported.facts)}`).toBe(`${text} -> `);
    }
  });
});

describe('adversarial: a claim the facts do not support is refused', () => {
  const cases: [label: string, text: string, kind: ClaimViolationKind][] = [
    ['wrong unit', 'Confermiamo 500 kg di FL-250.', 'unverified_measurement'],
    ['wrong month', 'Consegna richiesta entro il 15 novembre 2026.', 'unverified_date'],
    ['wrong day', 'Consegna richiesta entro il 12 ottobre 2026.', 'unverified_date'],
    ['wrong year', 'Consegna richiesta entro il 15 ottobre 2027.', 'unverified_date'],
    ['wrong numeric date', 'Consegna prevista il 20/09/2026.', 'unverified_date'],
    ['wrong quantity', 'Confermiamo 600 pezzi.', 'unverified_measurement'],
    ['wrong product', 'Vi proponiamo invece la flangia FL-300.', 'unverified_reference'],
    ['wrong customer', 'Gentile Brescia Impianti S.p.A.,', 'unverified_reference'],
    ['invented department', 'Ufficio Tecnico e Commerciale', 'unverified_reference'],
    ['invented employee', "Il vostro riferimento e' Paolo Ferrari.", 'unverified_reference'],
    [
      'invented stock availability',
      'Il materiale resta disponibile a magazzino.',
      'unverified_wording',
    ],
    ['invented certification', 'Siamo certificati secondo la norma vigente.', 'unverified_wording'],
    ['invented plant', 'La produzione avviene nel nostro stabilimento.', 'unverified_wording'],
    ['invented agreement', 'Come da accordo quadro in essere.', 'unverified_wording'],
    ['invented capability', 'Possiamo garantire la lavorazione interna.', 'unverified_wording'],
    ['invented price', "Il prezzo unitario e' di 12,50 EUR.", 'forbidden_commitment'],
    ['invented discount', 'Vi riconosciamo uno sconto del 7%.', 'unverified_measurement'],
    ['discount reusing a verified number', 'Applichiamo il 3% in meno.', 'unverified_measurement'],
    ['invented delivery commitment', 'Consegniamo in 10 giorni.', 'unverified_measurement'],
    ['invented capacity', 'Produciamo 20000 pezzi al mese.', 'unverified_measurement'],
    [
      'invented contact address',
      'Scrivete a ufficio.tecnico@alfa-meccanica.it.',
      'unverified_contact',
    ],
    [
      'invented web page',
      'Il riferimento e’ su www.alfa-meccanica.it/catalogo.',
      'unverified_contact',
    ],
    ['invented telephone number', 'Il riferimento e’ +39 030 1234567.', 'unverified_contact'],
  ];

  it.each(cases)('refuses %s', (_label, text, kind) => {
    const violations = check(text);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations).toContain(kind);
  });

  it('names the offending token so the case can say what was wrong', () => {
    expect(report('Confermiamo 500 kg.')).toContain('unverified_measurement:500 kg');
    expect(report('Consegna il 15 novembre 2026.')).toContain('unverified_date:15 novembre 2026');
    expect(report('Ufficio Tecnico e Commerciale')).toContain('unverified_reference:Tecnico');
  });
});

describe('the signature is the company’s, never the model’s', () => {
  it('grounds every word of the configured signature', () => {
    expect(report(SIGNATURE)).toBe('');
  });

  it('refuses a signature block the company never configured', () => {
    expect(check('Ufficio Tecnico e Commerciale\nAlfa Meccanica S.r.l.')).toContain(
      'unverified_reference',
    );
    expect(check('Alfa Meccanica S.p.A.')).toContain('unverified_reference');
  });
});

describe('what earlier guards let through', () => {
  it.each([
    ['500 kg', "Confermiamo 500 kg dell'articolo FL-250."],
    ['15 novembre 2026', 'Consegna prevista per il 15 novembre 2026.'],
    ['3 settimane', 'Offerta completa entro 3 settimane.'],
    ['Ufficio Tecnico e Commerciale', 'Ufficio Tecnico e Commerciale'],
    ['sconto del 3%', 'Applichiamo il 3% in meno.'],
    ['disponibile a magazzino', 'Il materiale resta disponibile a magazzino.'],
    ['accordo quadro', 'Come da accordo quadro in essere.'],
    ['nuovo impianto', 'La richiesta riguarda un nuovo impianto.'],
  ])('now refuses %s', (_label, text) => {
    expect(check(text).length).toBeGreaterThan(0);
  });
});
