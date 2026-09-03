import { describe, expect, it } from 'vitest';

import { emailDomain, isPublicEmailDomain, nameKey, normaliseAliasValue } from './entity.js';

describe('entity normalisation', () => {
  it('builds a name key without accents, punctuation and legal suffixes', () => {
    expect(nameKey('Officine Meccaniche Rossi S.r.l.')).toBe('officine meccaniche rossi');
    expect(nameKey('ROSSI SRL')).toBe('rossi');
    expect(nameKey('Società Agricola Bianchi & C. S.n.c.')).toBe('societa agricola bianchi c');
    expect(nameKey('SRL')).toBe('srl');
  });

  it('normalises aliases per kind', () => {
    expect(normaliseAliasValue('email', ' Acquisti@Cliente.IT ')).toBe('acquisti@cliente.it');
    expect(normaliseAliasValue('email_domain', '@Cliente.it')).toBe('cliente.it');
    expect(normaliseAliasValue('vat', 'it 01234567890')).toBe('IT01234567890');
    expect(normaliseAliasValue('code', 'c 0042')).toBe('C0042');
    expect(normaliseAliasValue('name', 'Rossi S.p.A.')).toBe('rossi');
  });

  it('separates company domains from public mailbox providers', () => {
    expect(emailDomain('mario@officine-rossi.it')).toBe('officine-rossi.it');
    expect(emailDomain('not-an-email')).toBeUndefined();
    expect(isPublicEmailDomain('gmail.com')).toBe(true);
    expect(isPublicEmailDomain('libero.it')).toBe(true);
    expect(isPublicEmailDomain('officine-rossi.it')).toBe(false);
  });
});
