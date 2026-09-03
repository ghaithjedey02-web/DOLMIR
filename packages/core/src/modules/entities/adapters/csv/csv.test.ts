import { describe, expect, it } from 'vitest';

import { parseCsv } from './csv.js';

describe('parseCsv', () => {
  it('parses semicolon-separated Italian exports with quotes, BOM and CRLF', () => {
    const text =
      '﻿codice;ragione_sociale;email\r\nC0042;"Officine Rossi; S.r.l.";acquisti@rossi.it\r\nC0043;"Bianchi ""B&B"" Snc";\r\n';
    const result = parseCsv(text);
    expect(result.ok && result.value).toEqual([
      { codice: 'C0042', ragione_sociale: 'Officine Rossi; S.r.l.', email: 'acquisti@rossi.it' },
      { codice: 'C0043', ragione_sociale: 'Bianchi "B&B" Snc', email: '' },
    ]);
  });

  it('parses comma-separated files and reports malformed input as a value', () => {
    const result = parseCsv('a,b\n1,2\n3,4');
    expect(result.ok && result.value).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
    const broken = parseCsv('a,b\n"unterminated,2');
    expect(!broken.ok && broken.error.code).toBe('CSV_UNTERMINATED_QUOTE');
    const empty = parseCsv('');
    expect(!empty.ok && empty.error.code).toBe('CSV_EMPTY');
  });
});
