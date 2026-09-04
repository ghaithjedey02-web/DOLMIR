import type { CompanyContext } from '@dolmir/core';

import { MONTH_INDEX, UNIT_ALIASES, parseQuantity } from '../domain/parsing.js';
import type { CommercialInboxRules } from '../domain/rules.js';
import type { CommercialAnalysis } from './resolve.js';

/**
 * GROUND — what a written reply is allowed to assert, and the check that every
 * assertion in one is allowed.
 *
 * The first guard compared a draft against a flat set of numeric strings, so
 * `500` stood equally for a quantity, a lead time and a discount: `500 kg`
 * passed because 500 was verified, `15 novembre 2026` passed because 15 and
 * 2026 were, and prose carrying no digits was never examined at all.
 *
 * Here a fact keeps its shape. A quantity is a value *and* a unit, a date is a
 * date, a lead time is a number of working days, a name is a name. A draft is
 * decomposed into claims of the same shapes, and a claim is grounded only when
 * a fact matches it on every component it asserts. Nothing is recognised by
 * phrase: the vocabulary is the deterministic one already used to read the
 * message, and the fact base is built from the same structure the drafting
 * model was given — so the check needs no access to the original message.
 *
 * Sources a claim may rest on, and nothing else:
 *
 *   A `document_evidence`  a span verified against the stored document text
 *   B `entity_record`      a field of an entity the resolver matched
 *   C `company_profile`    the company's own profile
 *   D `company_rule`       a versioned company rule
 *   E `system_wording`     wording the platform itself supplies
 */
export const FactSource = {
  DOCUMENT: 'document_evidence',
  RECORD: 'entity_record',
  PROFILE: 'company_profile',
  RULE: 'company_rule',
  SYSTEM: 'system_wording',
} as const;
export type FactSource = (typeof FactSource)[keyof typeof FactSource];

/** A number that means something: 500 pieces, 3 working days, 24 hours. */
export interface MeasurementFact {
  readonly value: number;
  /** Normalised unit, or `null` when the source itself states none. */
  readonly unit: string | null;
  readonly source: FactSource;
  /** Where it came from, for the audit: `line:0.quantity`, `rule:…lead_time_days`. */
  readonly ref: string;
}

export interface DateFact {
  /** `YYYY-MM-DD`, as DOLMIR computed it. */
  readonly iso: string;
  readonly source: FactSource;
  readonly ref: string;
}

/** A name, code or phrase a reply may use verbatim. */
export interface TermFact {
  readonly text: string;
  readonly source: FactSource;
  readonly ref: string;
}

export interface GroundedFacts {
  readonly measurements: readonly MeasurementFact[];
  readonly dates: readonly DateFact[];
  readonly terms: readonly TermFact[];
  /** The terms as text, longest first, so the longest match is masked before the shortest. */
  readonly phrases: readonly string[];
  /** Every word of every term, lowercased: the proper nouns a reply may name. */
  readonly words: ReadonlySet<string>;
  readonly emails: ReadonlySet<string>;
}

export type ClaimViolationKind =
  /** A number matching no verified value at all. */
  | 'unverified_number'
  /** A number whose unit contradicts the verified one: `500 kg` for 500 pieces. */
  | 'unverified_measurement'
  /** A date that is not the verified date: `15 novembre` for the 15th of October. */
  | 'unverified_date'
  /** A name, department or product nothing in the fact base grounds. */
  | 'unverified_reference'
  /** An address, link or contact the company profile does not carry. */
  | 'unverified_contact'
  /** A price, a currency or a discount. Refused whatever the facts say. */
  | 'forbidden_commitment';

export interface ClaimViolation {
  readonly kind: ClaimViolationKind;
  readonly token: string;
}

/** Any mention of money at all: DOLMIR holds no pricing and must never look as though it does. */
const MONEY = /(?:[€$£]|\bEUR\b|\bUSD\b|\bGBP\b|\beuros?\b|\bdollari?\b)/i;

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const LINK = /\b(?:https?:\/\/|www\.)[^\s,;)]+/gi;
const PHONE = /(?:\+\d[\d\s().-]{7,}\d)/g;

/**
 * Units of time and proportion a reply can claim, beside the units of measure
 * the reading already understands. `giorni lavorativi` is deliberately not the
 * same unit as `giorni`: a company that promises three working days has not
 * promised three days.
 */
const PERIOD_UNITS: Readonly<Record<string, string>> = {
  'giorni lavorativi': 'working_day',
  'giorno lavorativo': 'working_day',
  'working days': 'working_day',
  'working day': 'working_day',
  'business days': 'working_day',
  'business day': 'working_day',
  giorni: 'day',
  giorno: 'day',
  days: 'day',
  day: 'day',
  settimane: 'week',
  settimana: 'week',
  weeks: 'week',
  week: 'week',
  mesi: 'month',
  mese: 'month',
  months: 'month',
  month: 'month',
  ore: 'hour',
  ora: 'hour',
  hours: 'hour',
  hour: 'hour',
  anni: 'year',
  anno: 'year',
  years: 'year',
  year: 'year',
  '%': 'percent',
  percento: 'percent',
  'per cento': 'percent',
  percent: 'percent',
};

/**
 * Words a reply may capitalise without naming anything: courtesy forms, month
 * names and the openings and closings of a business letter. This is the whole
 * of class E, and it names no company, product, person or commitment — the
 * things that must be grounded cannot hide in it.
 */
const SYSTEM_WORDS: ReadonlySet<string> = new Set([
  ...MONTH_INDEX.keys(),
  // Italian courtesy forms, which are capitalised mid-sentence by convention.
  'la',
  'le',
  'lei',
  'loro',
  'vi',
  'voi',
  'ci',
  've',
  'si',
  'ne',
  'gli',
  'vostra',
  'vostro',
  'vostre',
  'vostri',
  'sua',
  'suo',
  'sue',
  'suoi',
  // Openings and closings.
  'buongiorno',
  'buonasera',
  'gentile',
  'gentili',
  'egregio',
  'egregi',
  'spettabile',
  'cordiali',
  'distinti',
  'saluti',
  'grazie',
  'dear',
  'hello',
  'regards',
  'sincerely',
  'best',
  'kind',
  // English pronouns.
  'we',
  'you',
  'your',
  'our',
  'i',
]);

/** A capital starts a new sentence after these, so it names nothing. */
const SENTENCE_END = new Set(['.', '!', '?', ':', ';', '\n', '\r', '•', '-', '–', '—']);

const MASK = 'x';

export function normaliseClaimUnit(text: string | null): string | null {
  if (text === null) return null;
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-zà-ÿ%\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return null;
  const words = cleaned.split(' ');
  for (const size of [2, 1]) {
    const candidate = words.slice(0, size).join(' ');
    if (candidate.length === 0) continue;
    const period = PERIOD_UNITS[candidate];
    if (period !== undefined) return period;
    const measure = UNIT_ALIASES[candidate];
    if (measure !== undefined) return measure;
  }
  return null;
}

/**
 * The facts a reply may rest on, built from the analysis, the company profile
 * and the company's rules — the same three inputs the drafting brief is made
 * of. The original message is not among them, and is not needed.
 */
export function buildGroundedFacts(
  analysis: CommercialAnalysis,
  company: CompanyContext,
  rules: CommercialInboxRules,
): GroundedFacts {
  const measurements: MeasurementFact[] = [];
  const dates: DateFact[] = [];
  const terms: TermFact[] = [];

  const addDate = (value: Date | null | undefined, source: FactSource, ref: string): void => {
    if (value === null || value === undefined) return;
    const iso = value.toISOString().slice(0, 10);
    if (!dates.some((fact) => fact.iso === iso)) dates.push({ iso, source, ref });
    // A reply may name the year of a date it is allowed to state.
    measurements.push({ value: value.getUTCFullYear(), unit: 'year', source, ref: `${ref}.year` });
  };
  const addTerm = (text: string | null | undefined, source: FactSource, ref: string): void => {
    if (text === null || text === undefined) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    terms.push({ text: trimmed, source, ref });
  };

  for (const [index, line] of analysis.lines.entries()) {
    const at = `line:${String(index)}`;
    if (line.quantity !== null) {
      measurements.push({
        value: line.quantity.value,
        unit: line.unit,
        source: FactSource.DOCUMENT,
        ref: `${at}.quantity`,
      });
    }
    addDate(line.deliveryDate?.value, FactSource.DOCUMENT, `${at}.deliveryDate`);
    addTerm(line.description.value, FactSource.DOCUMENT, `${at}.description`);
    addTerm(line.productCode?.quote, FactSource.DOCUMENT, `${at}.productCode`);
    if (line.product.kind === 'RESOLVED') {
      addTerm(line.product.match.entity.name, FactSource.RECORD, `${at}.product.name`);
      addTerm(line.product.match.entity.code, FactSource.RECORD, `${at}.product.code`);
    }
  }

  addDate(analysis.deliveryDate?.value, FactSource.DOCUMENT, 'analysis.deliveryDate');
  addTerm(analysis.senderOrganisation?.value, FactSource.DOCUMENT, 'analysis.senderOrganisation');
  for (const [index, asked] of analysis.requestedInformation.entries()) {
    addTerm(asked.value, FactSource.DOCUMENT, `requestedInformation:${String(index)}`);
  }
  if (analysis.customer.kind === 'RESOLVED') {
    addTerm(analysis.customer.match.entity.name, FactSource.RECORD, 'customer.name');
    addTerm(analysis.customer.match.entity.code, FactSource.RECORD, 'customer.code');
  }

  if (rules.quotationLeadTimeDays !== null) {
    measurements.push({
      value: rules.quotationLeadTimeDays,
      unit: 'working_day',
      source: FactSource.RULE,
      ref: 'rule:commercial_inbox.quotation_lead_time_days',
    });
  }
  if (rules.responseSlaHours !== null) {
    measurements.push({
      value: rules.responseSlaHours,
      unit: 'hour',
      source: FactSource.RULE,
      ref: 'rule:response_sla_hours',
    });
  }

  addTerm(company.profile.legalName, FactSource.PROFILE, 'profile.legalName');
  addTerm(company.profile.sector, FactSource.PROFILE, 'profile.sector');
  for (const [index, line] of (company.profile.signature ?? '').split('\n').entries()) {
    addTerm(line, FactSource.PROFILE, `profile.signature:${String(index)}`);
  }
  for (const [index, term] of company.terminology.entries()) {
    addTerm(term.term, FactSource.PROFILE, `terminology:${String(index)}`);
  }

  const words = new Set<string>();
  const emails = new Set<string>();
  for (const term of terms) {
    for (const match of term.text.matchAll(EMAIL)) emails.add(match[0].toLowerCase());
    for (const raw of term.text.split(/\s+/)) {
      const token = raw.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.]+$/gu, '');
      if (token.length > 0) words.add(token);
      for (const part of raw.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
        if (part.length > 0) words.add(part);
      }
    }
  }

  const phrases = [...new Set(terms.map((term) => term.text))].sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );

  return { measurements, dates, terms, phrases, words, emails };
}

interface DateClaim {
  readonly raw: string;
  readonly index: number;
  readonly day: number;
  readonly month: number;
  readonly year: number | null;
  /** True when the numbers could be read either way round, as in `10/09/2026`. */
  readonly ambiguous: boolean;
}

const ISO_DATE = /(\d{4})-(\d{1,2})-(\d{1,2})/g;
const NUMERIC_DATE = /(\d{1,2})\s*[/.-]\s*(\d{1,2})(?:\s*[/.-]\s*(\d{2,4}))?/g;
const MONTH_WORDS = [...MONTH_INDEX.keys()].sort((a, b) => b.length - a.length).join('|');
const DAY_THEN_MONTH = new RegExp(
  `(\\d{1,2})\\s*(?:°|º)?\\s+(?:di\\s+)?(${MONTH_WORDS})\\b(?:\\s+(?:del\\s+)?(\\d{4}))?`,
  'gi',
);
const MONTH_THEN_DAY = new RegExp(`\\b(${MONTH_WORDS})\\s+(\\d{1,2})\\b(?:,?\\s+(\\d{4}))?`, 'gi');

/** Every date a text states, however it is written. Positions are kept so they can be masked. */
export function findDateClaims(text: string): DateClaim[] {
  const claims: DateClaim[] = [];
  const taken: [number, number][] = [];
  const free = (start: number, end: number): boolean =>
    !taken.some(([from, to]) => start < to && end > from);
  const take = (claim: DateClaim): void => {
    if (!free(claim.index, claim.index + claim.raw.length)) return;
    taken.push([claim.index, claim.index + claim.raw.length]);
    claims.push(claim);
  };

  for (const match of text.matchAll(ISO_DATE)) {
    take({
      raw: match[0],
      index: match.index,
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      ambiguous: false,
    });
  }
  for (const pattern of [DAY_THEN_MONTH, MONTH_THEN_DAY]) {
    const dayFirst = pattern === DAY_THEN_MONTH;
    for (const match of text.matchAll(pattern)) {
      const month = MONTH_INDEX.get((dayFirst ? match[2] : match[1])?.toLowerCase() ?? '');
      const day = Number(dayFirst ? match[1] : match[2]);
      if (month === undefined || !Number.isFinite(day)) continue;
      take({
        raw: match[0],
        index: match.index,
        day,
        month,
        year: match[3] === undefined ? null : Number(match[3]),
        ambiguous: false,
      });
    }
  }
  for (const match of text.matchAll(NUMERIC_DATE)) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const year = match[3] === undefined ? null : Number(match[3]);
    take({
      raw: match[0],
      index: match.index,
      day: first,
      month: second,
      year: year === null ? null : year < 100 ? 2000 + year : year,
      ambiguous: true,
    });
  }
  return claims.sort((a, b) => a.index - b.index);
}

function dateIsGrounded(claim: DateClaim, facts: GroundedFacts): boolean {
  const readings: [number, number][] = claim.ambiguous
    ? [
        [claim.day, claim.month],
        [claim.month, claim.day],
      ]
    : [[claim.day, claim.month]];
  return facts.dates.some((fact) => {
    const [year, month, day] = fact.iso.split('-').map(Number) as [number, number, number];
    if (claim.year !== null && claim.year !== year) return false;
    return readings.some(([d, m]) => d === day && m === month);
  });
}

function measurementIsGrounded(value: number, unit: string | null, facts: GroundedFacts): boolean {
  return facts.measurements.some((fact) => {
    if (fact.value !== value) return false;
    // A bare number asserts no unit, so it only has to match a value. A number
    // that names its unit must agree with a fact that states the same one, or
    // with a fact whose own source stated none.
    return unit === null || fact.unit === null || fact.unit === unit;
  });
}

/** Replaces a span with filler of the same length, so later scans skip it but offsets survive. */
function mask(text: string, start: number, length: number): string {
  return text.slice(0, start) + MASK.repeat(length) + text.slice(start + length);
}

function maskPhrases(text: string, phrases: readonly string[]): string {
  let masked = text;
  for (const phrase of phrases) {
    if (phrase.length < 2) continue;
    const needle = phrase.toLowerCase();
    for (;;) {
      const at = masked.toLowerCase().indexOf(needle);
      if (at < 0) break;
      masked = mask(masked, at, needle.length);
    }
  }
  return masked;
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}.'\u2019-]*/gu;

/**
 * Masks a grounded name wherever it stands alone, so the digits inside an
 * article code are read as part of the code and not as a quantity: `DN250`
 * states no number. A token of digits alone is never masked this way — that
 * would be the flat token membership this guard exists to replace.
 */
function maskGroundedWords(text: string, words: ReadonlySet<string>): string {
  let masked = text;
  for (const match of [...text.matchAll(WORD)].reverse()) {
    const token = match[0];
    if (!/\p{L}/u.test(token)) continue;
    const bare = token.toLowerCase();
    if (!words.has(bare) && !words.has(bare.replace(/[.'\u2019-]+$/u, ''))) continue;
    masked = mask(masked, match.index, token.length);
  }
  return masked;
}

const GROUPERS = `${String.fromCharCode(160)}${String.fromCharCode(8239)}${String.fromCharCode(8201)}' `;
const NUMBER_WITH_UNIT = new RegExp(
  `(\\d[\\d.,${GROUPERS}]*\\d|\\d)\\s*(%|\\p{L}+(?:\\s+\\p{L}+)?)?`,
  'gu',
);
const CAPITALISED = /\p{Lu}[\p{L}\p{N}.'’-]*/gu;

/**
 * Decomposes a written reply into claims and refuses every one the facts do
 * not support. Order matters: money first, then contacts, then the phrases the
 * company and the message already contain, then dates, then measurements, and
 * finally the names left over. Each step masks what it has accounted for, so a
 * digit inside an article code is never read as a quantity.
 */
export function groundDraft(text: string, facts: GroundedFacts): ClaimViolation[] {
  const violations: ClaimViolation[] = [];
  const money = MONEY.exec(text);
  if (money !== null) violations.push({ kind: 'forbidden_commitment', token: money[0] });

  let rest = text;
  for (const pattern of [EMAIL, LINK, PHONE]) {
    for (const match of [...rest.matchAll(pattern)].reverse()) {
      const token = match[0];
      if (!facts.emails.has(token.toLowerCase())) {
        violations.push({ kind: 'unverified_contact', token });
      }
      rest = mask(rest, match.index, token.length);
    }
  }

  rest = maskGroundedWords(maskPhrases(rest, facts.phrases), facts.words);

  for (const claim of findDateClaims(rest).reverse()) {
    if (!dateIsGrounded(claim, facts)) {
      violations.push({ kind: 'unverified_date', token: claim.raw.trim() });
    }
    rest = mask(rest, claim.index, claim.raw.length);
  }

  for (const match of rest.matchAll(NUMBER_WITH_UNIT)) {
    const value = parseQuantity(match[1] ?? '');
    if (value === null) continue;
    const unit = normaliseClaimUnit(match[2] ?? null);
    if (measurementIsGrounded(value, unit, facts)) continue;
    violations.push({
      kind: unit === null ? 'unverified_number' : 'unverified_measurement',
      token: match[0].trim(),
    });
  }

  for (const match of rest.matchAll(CAPITALISED)) {
    const word = match[0];
    const bare = word.toLowerCase().replace(/[^\p{L}\p{N}.]+$/u, '');
    if (SYSTEM_WORDS.has(bare) || SYSTEM_WORDS.has(bare.replace(/\.$/, ''))) continue;
    if (facts.words.has(bare) || facts.words.has(bare.replace(/\.$/, ''))) continue;
    if (startsSentence(rest, match.index)) continue;
    violations.push({ kind: 'unverified_reference', token: word });
  }

  return violations;
}

/** True when nothing but whitespace, filler or a sentence end precedes this position. */
function startsSentence(text: string, index: number): boolean {
  for (let at = index - 1; at >= 0; at -= 1) {
    const character = text.charAt(at);
    if (character === ' ' || character === '\t') continue;
    return SENTENCE_END.has(character);
  }
  return true;
}
