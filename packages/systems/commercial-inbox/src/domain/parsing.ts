/**
 * Deterministic parsing of the values the model pointed at. The model says
 * *where* a quantity or a date is written; this code decides *what* it is. No
 * number and no date in a DOLMIR finding was produced by a model.
 */
const IT_MONTHS = [
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',
];
const EN_MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** Longest first, so "settembre" is not matched as "set". Shared with the drafting guard. */
export const MONTH_INDEX: ReadonlyMap<string, number> = new Map(
  [...IT_MONTHS, ...EN_MONTHS]
    .flatMap((name, index) => {
      const month = (index % 12) + 1;
      return [[name, month] as const, [name.slice(0, 3), month] as const];
    })
    .sort((a, b) => b[0].length - a[0].length),
);

/** Shared with the drafting guard, which must read a unit in a reply the same way. */
export const UNIT_ALIASES: Readonly<Record<string, string>> = {
  pz: 'pcs',
  pezzi: 'pcs',
  pezzo: 'pcs',
  pcs: 'pcs',
  pc: 'pcs',
  pieces: 'pcs',
  piece: 'pcs',
  unita: 'pcs',
  unità: 'pcs',
  units: 'pcs',
  unit: 'pcs',
  nr: 'pcs',
  n: 'pcs',
  kg: 'kg',
  chilogrammi: 'kg',
  kilograms: 'kg',
  g: 'g',
  grammi: 'g',
  grams: 'g',
  t: 't',
  tonnellate: 't',
  tons: 't',
  tonnes: 't',
  m: 'm',
  metri: 'm',
  metres: 'm',
  meters: 'm',
  mm: 'mm',
  cm: 'cm',
  l: 'l',
  lt: 'l',
  litri: 'l',
  litres: 'l',
  liters: 'l',
  mq: 'm2',
  m2: 'm2',
  sqm: 'm2',
};

/** Thin and non-breaking spaces are used as digit groupers; built from code points, never typed. */
const NBSP = String.fromCharCode(160);
const NARROW_NBSP = String.fromCharCode(8239);
const THIN_SPACE = String.fromCharCode(8201);
const GROUPERS = `${NBSP}${NARROW_NBSP}${THIN_SPACE}'`;
const QUANTITY_PATTERN = new RegExp(`(\\d[\\d.,${GROUPERS} ]*\\d|\\d)`);
const GROUPER_PATTERN = new RegExp(`[${GROUPERS} ]`, 'g');
const INVISIBLE_SPACE_PATTERN = new RegExp(`[${NBSP}${NARROW_NBSP}${THIN_SPACE}]`, 'g');

/**
 * Reads a quantity out of the text it was written in: `500`, `n. 500`,
 * `500 pz`, `1.000` (Italian thousands), `1,000` (English thousands),
 * `1.500,50`, `1,500.50`.
 *
 * When both separators appear the last one is the decimal separator. When only
 * one appears and exactly three digits follow it, it is read as a thousands
 * separator; otherwise as a decimal point. Anything that is not a plain
 * positive number returns `null` rather than a guess.
 */
export function parseQuantity(text: string): number | null {
  const match = QUANTITY_PATTERN.exec(text.replace(/\u2019/g, "'"));
  const raw = match?.[1];
  if (raw === undefined) return null;
  const cleaned = raw.replace(GROUPER_PATTERN, '');
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  let normalised: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    normalised = cleaned.split(thousands).join('').replace(decimal, '.');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const separator = lastDot >= 0 ? '.' : ',';
    const index = lastDot >= 0 ? lastDot : lastComma;
    const after = cleaned.length - index - 1;
    const occurrences = cleaned.split(separator).length - 1;
    normalised =
      after === 3 && (occurrences > 1 || cleaned.length > 4)
        ? cleaned.split(separator).join('')
        : cleaned.replace(separator, '.');
  } else {
    normalised = cleaned;
  }
  const value = Number(normalised);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 1000) / 1000;
}

/**
 * Normalises the unit a quantity was written with. A quantity quote such as
 * "500 pezzi" carries its own unit, so a leading number is dropped first;
 * `m2` and other units that contain a digit survive. Unknown units are kept as
 * the sender wrote them, lowercased, rather than replaced by a guess.
 */
export function parseUnit(text: string | null): string | null {
  if (text === null) return null;
  const token = text
    .toLowerCase()
    .replace(/^[\d.,\s]+/, '')
    .replace(/[^a-zà-ÿ0-9]/g, '')
    .trim();
  if (token.length === 0) return null;
  return UNIT_ALIASES[token] ?? token.slice(0, 20);
}

export interface DateParsingOptions {
  /** Used to infer a missing year: the next occurrence on or after this instant. */
  readonly reference: Date;
  /** Decides `03/04` when both numbers could be a month; Italian and most of Europe write the day first. */
  readonly dayFirst: boolean;
}

const utcDate = (year: number, month: number, day: number): Date | null => {
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return valid ? date : null;
};

/**
 * Reads a delivery date out of the text it was written in. Understands ISO,
 * numeric day/month forms, and Italian or English month names, with or without
 * a year. A missing year becomes the next occurrence on or after the reference
 * date, so "15 ottobre" read in September means this year and read in November
 * means next year. Unparseable text returns `null`.
 */
export function parseDeliveryDate(text: string, options: DateParsingOptions): Date | null {
  const value = text.toLowerCase().replace(INVISIBLE_SPACE_PATTERN, ' ');

  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value);
  if (iso?.[1] !== undefined && iso[2] !== undefined && iso[3] !== undefined) {
    return utcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  const numeric = /(\d{1,2})\s*[/.-]\s*(\d{1,2})(?:\s*[/.-]\s*(\d{2,4}))?/.exec(value);
  if (numeric?.[1] !== undefined && numeric[2] !== undefined) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    // A number above twelve can only be a day, whatever the convention.
    const dayFirst = first > 12 ? true : second > 12 ? false : options.dayFirst;
    const day = dayFirst ? first : second;
    const month = dayFirst ? second : first;
    const year = numeric[3] === undefined ? null : fullYear(Number(numeric[3]));
    return year === null ? inferYear(month, day, options.reference) : utcDate(year, month, day);
  }

  for (const [name, month] of MONTH_INDEX) {
    const index = value.indexOf(name);
    if (index < 0) continue;
    const before = /(\d{1,2})\s*(?:°|º)?\s*$/.exec(value.slice(0, index));
    const after = /^\s*,?\s*(\d{1,2})(?!\d)/.exec(value.slice(index + name.length));
    const day = Number(before?.[1] ?? after?.[1]);
    if (!Number.isFinite(day) || day < 1 || day > 31) continue;
    const yearMatch = /(\d{4})/.exec(value.slice(index));
    const year = yearMatch?.[1] === undefined ? null : Number(yearMatch[1]);
    return year === null ? inferYear(month, day, options.reference) : utcDate(year, month, day);
  }
  return null;
}

function fullYear(value: number): number {
  return value < 100 ? 2000 + value : value;
}

/** The next occurrence of this day and month on or after the reference date. */
function inferYear(month: number, day: number, reference: Date): Date | null {
  const thisYear = utcDate(reference.getUTCFullYear(), month, day);
  if (thisYear === null) return null;
  const startOfReferenceDay = Date.UTC(
    reference.getUTCFullYear(),
    reference.getUTCMonth(),
    reference.getUTCDate(),
  );
  if (thisYear.getTime() >= startOfReferenceDay) return thisYear;
  return utcDate(reference.getUTCFullYear() + 1, month, day);
}

/** Numbers and dates a draft may contain, for the guard in the drafting step. */
export function numericTokens(text: string): string[] {
  return [...text.matchAll(/\d[\d.,:/-]*\d|\d/g)].map((match) => match[0]);
}
