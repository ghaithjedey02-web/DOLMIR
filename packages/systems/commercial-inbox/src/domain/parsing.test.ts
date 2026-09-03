import { describe, expect, it } from 'vitest';

import { numericTokens, parseDeliveryDate, parseQuantity, parseUnit } from './parsing.js';

const reference = new Date('2026-09-03T00:00:00.000Z');
const italian = { reference, dayFirst: true };
const english = { reference, dayFirst: false };
const iso = (date: Date | null) => date?.toISOString().slice(0, 10) ?? null;

describe('parseQuantity', () => {
  it('reads plain, prefixed and suffixed quantities', () => {
    expect(parseQuantity('500')).toBe(500);
    expect(parseQuantity('n. 500')).toBe(500);
    expect(parseQuantity('500 pz')).toBe(500);
    expect(parseQuantity('500pz')).toBe(500);
    expect(parseQuantity('circa 250 unità')).toBe(250);
  });

  it('reads both thousands conventions and both decimal conventions', () => {
    expect(parseQuantity('1.000')).toBe(1000);
    expect(parseQuantity('1,000')).toBe(1000);
    expect(parseQuantity('12.500')).toBe(12500);
    expect(parseQuantity('1.500,50')).toBe(1500.5);
    expect(parseQuantity('1,500.50')).toBe(1500.5);
    expect(parseQuantity('0,5')).toBe(0.5);
    expect(parseQuantity('1.5')).toBe(1.5);
    expect(parseQuantity("1'000")).toBe(1000);
  });

  it('returns null rather than guessing', () => {
    expect(parseQuantity('alcune decine')).toBeNull();
    expect(parseQuantity('')).toBeNull();
    expect(parseQuantity('0')).toBeNull();
    expect(parseQuantity('-5')).toBe(5); // the sign is not part of a quantity quote
  });
});

describe('parseUnit', () => {
  it('normalises the units an Italian or English message uses', () => {
    expect(parseUnit('pz')).toBe('pcs');
    expect(parseUnit('Pezzi')).toBe('pcs');
    expect(parseUnit('units')).toBe('pcs');
    expect(parseUnit('Kg')).toBe('kg');
    expect(parseUnit('tonnellate')).toBe('t');
    expect(parseUnit('mq')).toBe('m2');
    expect(parseUnit('barattoli')).toBe('barattoli');
    // A quantity quote carries its own unit, so the number is dropped first.
    expect(parseUnit('500 pezzi')).toBe('pcs');
    expect(parseUnit('1.000 kg')).toBe('kg');
    expect(parseUnit('12 m2')).toBe('m2');
    expect(parseUnit('500')).toBeNull();
    expect(parseUnit(null)).toBeNull();
    expect(parseUnit('   ')).toBeNull();
  });
});

describe('parseDeliveryDate', () => {
  it('reads ISO and numeric forms, respecting the language convention', () => {
    expect(iso(parseDeliveryDate('2026-10-15', italian))).toBe('2026-10-15');
    expect(iso(parseDeliveryDate('entro il 15/10/2026', italian))).toBe('2026-10-15');
    expect(iso(parseDeliveryDate('15-10-2026', italian))).toBe('2026-10-15');
    expect(iso(parseDeliveryDate('15.10.2026', italian))).toBe('2026-10-15');
    expect(iso(parseDeliveryDate('15/10/26', italian))).toBe('2026-10-15');
    // The same digits mean different days in the two conventions.
    expect(iso(parseDeliveryDate('03/04/2026', italian))).toBe('2026-04-03');
    expect(iso(parseDeliveryDate('03/04/2026', english))).toBe('2026-03-04');
    // A number above twelve can only be a day, whatever the convention.
    expect(iso(parseDeliveryDate('15/10/2026', english))).toBe('2026-10-15');
  });

  it('reads month names in Italian and English, with and without a year', () => {
    expect(iso(parseDeliveryDate('15 ottobre 2026', italian))).toBe('2026-10-15');
    expect(iso(parseDeliveryDate('entro il 15 ottobre', italian))).toBe('2026-10-15');
    expect(iso(parseDeliveryDate('15 ott', italian))).toBe('2026-10-15');
    expect(iso(parseDeliveryDate('October 15, 2026', english))).toBe('2026-10-15');
    expect(iso(parseDeliveryDate('15 October', english))).toBe('2026-10-15');
    expect(iso(parseDeliveryDate('by 5 May 2027', english))).toBe('2027-05-05');
    expect(iso(parseDeliveryDate('30 settembre', italian))).toBe('2026-09-30');
  });

  it('infers the next occurrence when the year is missing', () => {
    // Read in September, a March date belongs to the following year.
    expect(iso(parseDeliveryDate('15 marzo', italian))).toBe('2027-03-15');
    // Today still counts as the next occurrence.
    expect(iso(parseDeliveryDate('3 settembre', italian))).toBe('2026-09-03');
  });

  it('returns null for text that is not a date, and for impossible dates', () => {
    expect(parseDeliveryDate('appena possibile', italian)).toBeNull();
    expect(parseDeliveryDate('quanto prima', italian)).toBeNull();
    expect(parseDeliveryDate('31/02/2026', italian)).toBeNull();
    expect(parseDeliveryDate('2026-13-01', italian)).toBeNull();
  });
});

describe('numericTokens', () => {
  it('finds every number and date-like token a draft contains', () => {
    expect(numericTokens('Confermiamo 250 pezzi entro il 15/10/2026 a 12,50 EUR')).toEqual([
      '250',
      '15/10/2026',
      '12,50',
    ]);
    expect(numericTokens('nessun numero')).toEqual([]);
  });
});
