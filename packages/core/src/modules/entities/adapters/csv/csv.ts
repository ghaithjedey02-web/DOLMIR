import { ValidationError } from '../../../../kernel/errors.js';
import { err, ok, type Result } from '../../../../kernel/result.js';

/**
 * A small RFC 4180 parser: comma or semicolon separated (Italian exports use
 * semicolons), quoted fields with doubled quotes, CRLF or LF. Returns rows as
 * records keyed by the header. Deterministic; no external dependency.
 */
export function parseCsv(
  text: string,
  options: { readonly delimiter?: ',' | ';' } = {},
): Result<Record<string, string>[], ValidationError> {
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] ?? '';
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (quoted) {
    return err(
      new ValidationError('CSV_UNTERMINATED_QUOTE', 'The CSV ends inside a quoted field.'),
    );
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (header === undefined) {
    return err(new ValidationError('CSV_EMPTY', 'The CSV has no header row.'));
  }
  const keys = header.map((key) => key.trim());
  const records = body.map((cells) => {
    const record: Record<string, string> = {};
    keys.forEach((key, index) => {
      record[key] = (cells[index] ?? '').trim();
    });
    return record;
  });
  return ok(records);
}

function detectDelimiter(text: string): ',' | ';' {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  return (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
}
