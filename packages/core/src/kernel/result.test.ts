import { describe, expect, it } from 'vitest';

import {
  type Result,
  andThen,
  collect,
  err,
  isErr,
  isOk,
  map,
  mapErr,
  ok,
  unwrapOr,
} from './result.js';

/** A realistic producer: the caller cannot know statically which variant comes back. */
const parsePositive = (raw: string): Result<number, string> => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? ok(n) : err(`not a positive integer: ${raw}`);
};

describe('Result', () => {
  it('narrows on ok/err', () => {
    const success = parsePositive('42');
    const failure = parsePositive('boom');
    expect(isOk(success)).toBe(true);
    expect(isErr(failure)).toBe(true);
    if (success.ok) expect(success.value).toBe(42);
    if (!failure.ok) expect(failure.error).toBe('not a positive integer: boom');
  });

  it('maps values and errors independently', () => {
    expect(map(parsePositive('2'), (n) => n * 2)).toEqual(ok(4));
    expect(map(parsePositive('x'), (n) => n * 2)).toEqual(err('not a positive integer: x'));
    expect(mapErr(parsePositive('x'), (e) => `${e}!`)).toEqual(err('not a positive integer: x!'));
    expect(mapErr(parsePositive('1'), (e) => `${e}!`)).toEqual(ok(1));
  });

  it('chains with andThen and short-circuits on error', () => {
    const halve = (n: number): Result<number, string> => (n % 2 === 0 ? ok(n / 2) : err('odd'));
    expect(andThen(parsePositive('8'), halve)).toEqual(ok(4));
    expect(andThen(parsePositive('7'), halve)).toEqual(err('odd'));
    expect(andThen(parsePositive('x'), halve)).toEqual(err('not a positive integer: x'));
  });

  it('collects a list, failing on the first error', () => {
    expect(collect([parsePositive('1'), parsePositive('2')])).toEqual(ok([1, 2]));
    expect(collect([parsePositive('1'), parsePositive('a'), parsePositive('b')])).toEqual(
      err('not a positive integer: a'),
    );
    expect(unwrapOr(parsePositive('x'), 9)).toBe(9);
    expect(unwrapOr(parsePositive('3'), 9)).toBe(3);
  });
});
