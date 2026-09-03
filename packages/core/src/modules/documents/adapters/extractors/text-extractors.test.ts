import { describe, expect, it } from 'vitest';

import {
  HtmlTextExtractor,
  PlainTextExtractor,
  defaultTextExtractor,
  htmlToText,
} from './text-extractors.js';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('text extractors', () => {
  it('extracts plain text with normalised line breaks and the declared charset', async () => {
    const extractor = new PlainTextExtractor();
    expect(extractor.supports('text/plain; charset=utf-8')).toBe(true);
    expect(extractor.supports('application/pdf')).toBe(false);
    const result = await extractor.extract({
      body: bytes('Buongiorno,\r\npotete inviarci un preventivo?\r\n'),
      contentType: 'text/plain; charset=utf-8',
      filename: null,
    });
    expect(result.ok && result.value).toEqual([
      { part: 0, text: 'Buongiorno,\npotete inviarci un preventivo?\n' },
    ]);
    const latin = await extractor.extract({
      body: new Uint8Array([0x70, 0x69, 0xf9]),
      contentType: 'text/plain; charset=iso-8859-1',
      filename: null,
    });
    expect(latin.ok && latin.value[0]?.text).toBe('più');
  });

  it('turns HTML into readable text, keeping block structure and decoding entities', () => {
    const html = `<html><head><style>p{}</style><title>x</title></head><body>
      <p>Buongiorno,</p><!-- hidden -->
      <div>potete inviarci un <b>preventivo</b> per 250&nbsp;flange?</div>
      <table><tr><td>Codice</td><td>FL-250</td></tr></table>
      <p>Cordiali saluti &amp; grazie &egrave; &#8364; &#x20AC;</p>
      <script>alert(1)</script>
    </body></html>`;
    expect(htmlToText(html)).toBe(
      'Buongiorno,\npotete inviarci un preventivo per 250 flange?\nCodice\tFL-250\nCordiali saluti & grazie è € €',
    );
  });

  it('dispatches by content type and reports unsupported formats as a value', async () => {
    const extractor = defaultTextExtractor();
    expect(extractor.supports('text/html; charset=utf-8', null)).toBe(true);
    expect(extractor.supports('application/pdf', 'disegno.pdf')).toBe(false);
    const html = await extractor.extract({
      body: bytes('<p>Ciao</p>'),
      contentType: 'text/html',
      filename: null,
    });
    expect(html.ok && html.value).toEqual([{ part: 0, text: 'Ciao' }]);
    const pdf = await extractor.extract({
      body: bytes('%PDF-1.4'),
      contentType: 'application/pdf',
      filename: 'disegno.pdf',
    });
    expect(!pdf.ok && pdf.error.code).toBe('TEXT_EXTRACTION_UNSUPPORTED');
    expect(new HtmlTextExtractor().name).toBe('html');
  });
});
