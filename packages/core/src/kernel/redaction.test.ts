import { describe, expect, it } from 'vitest';

import { REDACTED, redactForLog, redactText, safeSnippet } from './redaction.js';

describe('redaction', () => {
  it('removes emails, phone numbers, VAT numbers, fiscal codes and IBANs', () => {
    const text =
      'Contattare m.brambilla@tecnoflex-lecco.example al +39 0341 123456 oppure 348 1234567. ' +
      'P.IVA IT01234567890, CF RSSMRA80A01F205X, IBAN IT60X0542811101000000123456.';
    const redacted = redactText(text);
    expect(redacted).not.toContain('brambilla');
    expect(redacted).not.toContain('0341');
    expect(redacted).not.toContain('1234567');
    expect(redacted).not.toContain('01234567890');
    expect(redacted).not.toContain('RSSMRA80A01F205X');
    expect(redacted).not.toContain('IT60X0542811101000000123456');
    expect(redacted).toContain('[EMAIL]');
    expect(redacted).toContain('[PHONE]');
    expect(redacted).toContain('[VAT]');
    expect(redacted).toContain('[CF]');
    expect(redacted).toContain('[IBAN]');
  });

  it('truncates before redacting so a raw prefix is never logged', () => {
    const snippet = safeSnippet('ordine per rossi@example.com con 2000 pezzi', 30);
    expect(snippet.length).toBeLessThanOrEqual(30 + '[EMAIL]'.length);
    expect(snippet).not.toContain('rossi@');
  });

  it('redacts secret-looking keys wholesale and strings deeply', () => {
    const value = {
      apiKey: 'sk-ant-secret',
      Authorization: 'Bearer abc',
      nested: { password: 'pw', note: 'call 02 12345678', when: new Date('2026-09-02T00:00:00Z') },
      list: ['a@b.example', 42, null],
    };
    expect(redactForLog(value)).toEqual({
      apiKey: REDACTED,
      Authorization: REDACTED,
      nested: { password: REDACTED, note: 'call [PHONE]', when: '2026-09-02T00:00:00.000Z' },
      list: ['[EMAIL]', 42, null],
    });
  });
});
