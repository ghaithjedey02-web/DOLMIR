/**
 * Redaction for anything that reaches logs, telemetry or error responses.
 *
 * DOLMIR processes business email that names people at the client's own
 * customers. Under the DPA DOLMIR is a processor; leaking that data into logs
 * is a reportable breach. Text is redacted or it is not logged.
 *
 * Over-redaction is acceptable; under-redaction is not.
 */

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g;
// Partita IVA (11 digits, optional IT prefix).
const VAT = /\b(?:IT)?\d{11}\b/g;
// Codice fiscale (16 alphanumeric characters in the personal-code layout).
const CODICE_FISCALE = /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/g;
// Italian phone numbers, with or without +39, spaces, dots or dashes.
const PHONE = /(?:\+39[\s.-]?)?(?:0\d{1,3}|3\d{2})[\s.-]?\d{5,8}\b/g;

export function redactText(input: string): string {
  return input
    .replace(EMAIL, '[EMAIL]')
    .replace(IBAN, '[IBAN]')
    .replace(CODICE_FISCALE, '[CF]')
    .replace(VAT, '[VAT]')
    .replace(PHONE, '[PHONE]');
}

/** Truncate, then redact — never log a raw prefix. */
export function safeSnippet(input: string, maxChars = 200): string {
  return redactText(input.slice(0, maxChars));
}

const SECRET_KEY =
  /(pass(word|phrase)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|signature)/i;

export const REDACTED = '[REDACTED]';

/**
 * Deep-copies a value for logging: secret-looking keys are replaced wholesale,
 * every string is redacted, everything else passes through.
 */
export function redactForLog(value: unknown): unknown {
  return redactDeep(value, { strings: true }, 0);
}

/**
 * Deep-copies a value for persistence in tenant-owned records (audit details,
 * event payloads): secret-looking keys are blanked, business text is kept —
 * Row-Level Security, not redaction, protects that data.
 */
export function redactSecrets(value: unknown): unknown {
  return redactDeep(value, { strings: false }, 0);
}

function redactDeep(value: unknown, options: { strings: boolean }, depth: number): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return options.strings ? redactText(value) : value;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, options, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SECRET_KEY.test(key) ? REDACTED : redactDeep(entry, options, depth + 1);
  }
  return result;
}
