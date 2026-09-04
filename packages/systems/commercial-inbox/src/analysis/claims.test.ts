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
import type { CommercialAnalysis } from './resolve.js';

/**
 * The real RFQ, as the deterministic half of the pipeline resolved it:
 *
 *   500 pieces of FL-250 / "flangia tornita S355 DN250 PN16"
 *   requested for the 15th of October 2026 (the year inferred from receipt)
 *   from Officine Meccaniche Rossi S.r.l., quotation lead time 3 working days.
 *
 * Every adversarial case below is written against exactly these facts, so a
 * refusal is never an artefact of a thinner fact base than production has.
 */
const DELIVERY = new Date('2026-10-15T00:00:00.000Z');

const analysis = {
  lines: [
    {
      index: 0,
      description: { value: 'flangia tornita S355 DN250 PN16', quote: '', source: 'email' },
      productCode: { value: 'FL-250', quote: 'FL-250', source: 'email' },
      product: {
        kind: 'RESOLVED',
        match: { entity: { name: 'Flangia tornita S355 DN250 PN16', code: 'FL-250' } },
      },
      quantity: { value: 500, quote: '500 pezzi', source: 'email' },
      unit: 'pcs',
      deliveryDate: { value: DELIVERY, quote: '15 ottobre', source: 'email' },
    },
  ],
  deliveryDate: { value: DELIVERY, quote: '15 ottobre', source: 'email' },
  requestedInformation: [
    { value: "Potete confermarci la fattibilita' e i tempi di consegna?", source: 'email' },
  ],
  senderOrganisation: null,
  customer: {
    kind: 'RESOLVED',
    match: { entity: { name: 'Officine Meccaniche Rossi S.r.l.', code: 'C0042' } },
  },
  rejectedQuotes: [],
} as unknown as CommercialAnalysis;

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

const rules = {
  acknowledgeQuoteRequests: true,
  quotationLeadTimeDays: 3,
  ignoredSenderDomains: [],
  requireKnownCustomer: false,
  replyLanguage: 'it',
  responseSlaHours: 24,
} satisfies CommercialInboxRules;

const facts = buildGroundedFacts(analysis, company, rules);
const check = (text: string): ClaimViolationKind[] =>
  groundDraft(text, facts).map((violation) => violation.kind);
const kindsOf = (text: string): string =>
  groundDraft(text, facts)
    .map((violation) => `${violation.kind}:${violation.token}`)
    .join(' | ');

describe('the fact base', () => {
  it('keeps a quantity together with its unit, and a lead time with its own', () => {
    expect(facts.measurements).toContainEqual({
      value: 500,
      unit: 'pcs',
      source: 'document_evidence',
      ref: 'line:0.quantity',
    });
    expect(facts.measurements).toContainEqual({
      value: 3,
      unit: 'working_day',
      source: 'company_rule',
      ref: 'rule:commercial_inbox.quotation_lead_time_days',
    });
  });

  it('records the requested date as a date, with the source that produced it', () => {
    expect(facts.dates).toContainEqual({
      iso: '2026-10-15',
      source: 'document_evidence',
      ref: 'line:0.deliveryDate',
    });
  });

  it('grounds names from the catalogue and the company profile, and nothing else', () => {
    expect(facts.words.has('flangia')).toBe(true);
    expect(facts.words.has('commerciale')).toBe(true);
    expect(facts.words.has('rossi')).toBe(true);
    // The company has a commercial office; it has never declared a technical one.
    expect(facts.words.has('tecnico')).toBe(false);
    expect(facts.emails.has('vendite@alfa-meccanica.it')).toBe(true);
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
    expect(normaliseClaimUnit('preventivo')).toBeNull();
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
    expect(kindsOf(body)).toBe('');
  });

  it('accepts the same facts written differently: the guard checks meaning, not phrasing', () => {
    for (const body of [
      'Confermiamo la ricezione della richiesta di 500 pezzi.',
      'La quantita’ richiesta e’ di 500 pz.',
      'Consegna desiderata: 15/10/2026.',
      'Consegna desiderata: 2026-10-15.',
      'Il preventivo seguira’ entro 3 giorni lavorativi.',
      'Our quotation will follow within 3 working days.',
      'Nel 2026 la consegna richiesta cade il 15 ottobre.',
      'Rispondiamo di norma entro 24 ore.',
    ]) {
      expect(`${body} -> ${kindsOf(body)}`).toBe(`${body} -> `);
    }
  });

  it('accepts the counterpart, the article and the company by name', () => {
    const body =
      'Gentile Officine Meccaniche Rossi S.r.l., la flangia tornita S355 DN250 PN16 e’ a catalogo presso Alfa Meccanica S.r.l.';
    expect(kindsOf(body)).toBe('');
  });
});

describe('adversarial: a claim the facts do not support is refused', () => {
  const cases: [label: string, text: string, kind: ClaimViolationKind][] = [
    ['wrong unit', 'Confermiamo 500 kg di FL-250.', 'unverified_measurement'],
    ['wrong month', 'Consegna richiesta entro il 15 novembre 2026.', 'unverified_date'],
    ['wrong day', 'Consegna richiesta entro il 12 ottobre 2026.', 'unverified_date'],
    ['wrong year', 'Consegna richiesta entro il 15 ottobre 2027.', 'unverified_date'],
    ['wrong numeric date', 'Spedizione prevista il 20/09/2026.', 'unverified_date'],
    ['wrong quantity', 'Confermiamo 600 pezzi.', 'unverified_measurement'],
    ['wrong product', 'Vi proponiamo invece la flangia FL-300.', 'unverified_reference'],
    ['wrong customer', 'Gentile Brescia Impianti S.p.A.,', 'unverified_reference'],
    [
      'wrong lead-time unit (weeks)',
      'Offerta completa entro 3 settimane.',
      'unverified_measurement',
    ],
    ['wrong lead-time unit (months)', 'Offerta completa entro 3 mesi.', 'unverified_measurement'],
    ['wrong lead-time unit (days)', 'Offerta completa entro 3 giorni.', 'unverified_measurement'],
    ['invented department', 'Ufficio Tecnico e Commerciale', 'unverified_reference'],
    [
      'invented employee',
      'Il vostro referente e’ il geometra Paolo Ferrari.',
      'unverified_reference',
    ],
    [
      'invented stock availability',
      'Il materiale e’ disponibile presso il Magazzino Centrale.',
      'unverified_reference',
    ],
    ['invented certification claim', 'Siamo certificati ISO 9001.', 'unverified_reference'],
    ['invented price', 'Il prezzo unitario e’ di 12,50 EUR.', 'forbidden_commitment'],
    ['invented discount', 'Vi riconosciamo uno sconto del 7%.', 'unverified_measurement'],
    [
      'discount reusing a verified number',
      'Vi riconosciamo uno sconto del 3%.',
      'unverified_measurement',
    ],
    [
      'invented delivery commitment',
      'Garantiamo la consegna in 10 giorni.',
      'unverified_measurement',
    ],
    ['invented capacity claim', 'Produciamo 20000 pezzi al mese.', 'unverified_measurement'],
    [
      'invented contact address',
      'Scrivete a ufficio.tecnico@alfa-meccanica.it.',
      'unverified_contact',
    ],
    [
      'invented web page',
      'Trovate il catalogo su www.alfa-meccanica.it/catalogo.',
      'unverified_contact',
    ],
    ['invented telephone number', 'Chiamateci al +39 030 1234567.', 'unverified_contact'],
  ];

  it.each(cases)('refuses %s', (_label, text, kind) => {
    const violations = check(text);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations).toContain(kind);
  });

  it('names the offending token so the case can say what was wrong', () => {
    expect(kindsOf('Confermiamo 500 kg.')).toContain('unverified_measurement:500 kg');
    expect(kindsOf('Consegna il 15 novembre 2026.')).toContain('unverified_date:15 novembre 2026');
    expect(kindsOf('Ufficio Tecnico e Commerciale')).toContain('unverified_reference:Tecnico');
  });
});

describe('invented contractual and capability claims', () => {
  it('refuses an agreement the facts never mention when it names anything', () => {
    // "Accordo Quadro" and "Contratto" are names of instruments the company has
    // no record of; the sentence carries no digits, and the old guard passed it.
    expect(check('Come da Accordo Quadro in essere, confermiamo le condizioni.')).toContain(
      'unverified_reference',
    );
    expect(check('Applichiamo le condizioni del Contratto Nazionale Metalmeccanico.')).toContain(
      'unverified_reference',
    );
  });

  it('refuses a capability claim that names a plant, line or certification', () => {
    expect(check('La produzione avviene nello Stabilimento di Brescia.')).toContain(
      'unverified_reference',
    );
    expect(check('Disponiamo di una Linea Automatica dedicata.')).toContain('unverified_reference');
  });
});

describe('the signature is the company’s, never the model’s', () => {
  it('grounds every word of the configured signature', () => {
    expect(kindsOf(SIGNATURE)).toBe('');
  });

  it('refuses a signature block the company never configured', () => {
    expect(check('Ufficio Tecnico e Commerciale\nAlfa Meccanica S.r.l.')).toContain(
      'unverified_reference',
    );
    expect(check('Alfa Meccanica S.p.A.')).toContain('unverified_reference');
  });
});

describe('what the old guard let through', () => {
  // Every one of these passed the token-membership guard. They are the audit
  // findings, kept as a regression list.
  it.each([
    ['500 kg', 'Confermiamo 500 kg dell’articolo FL-250.'],
    ['15 novembre 2026', 'Consegna prevista per il 15 novembre 2026.'],
    ['3 settimane', 'Offerta completa entro 3 settimane.'],
    ['Ufficio Tecnico e Commerciale', 'Ufficio Tecnico e Commerciale'],
    ['sconto del 3%', 'Vi confermiamo uno sconto del 3%.'],
    ['disponibile a magazzino', 'Il pezzo e’ disponibile presso il Magazzino Centrale.'],
    ['accordi quadro', 'Come da Accordo Quadro gia’ in essere.'],
  ])('now refuses %s', (_label, text) => {
    expect(check(text).length).toBeGreaterThan(0);
  });
});
