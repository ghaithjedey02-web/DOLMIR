import { ValidationError } from '../../../kernel/errors.js';
import { err, ok, type Result } from '../../../kernel/result.js';
import type { InboundAttachment, InboundMessage } from '../domain/inbound-message.js';

/**
 * Inbound mail is untrusted input. These limits and the filename rules run
 * before anything is stored, so a hostile message is refused at the boundary
 * rather than half-ingested. Bytes are never executed, never decompressed and
 * never interpreted; only text extraction reads them, and only for formats an
 * extractor declares it supports.
 */
export const ATTACHMENT_LIMITS = {
  /** Attachments per message. Beyond this the message is refused, not truncated. */
  maxCount: 50,
  /** One attachment. Larger ones are refused; the message body is still ingested. */
  maxBytes: 20 * 1024 * 1024,
  maxFilenameLength: 200,
} as const;

const CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}]`,
  'g',
);
const UNSAFE_FILENAME = /[/\\:*?"<>|]/g;

/**
 * A filename from a message is a label, never a path. Directory separators,
 * traversal segments, control characters and leading dots are removed, so the
 * value is safe to store, log and show. Storage keys are content-addressed
 * and never derived from this value.
 */
export function safeFilename(raw: string | null): string | null {
  if (raw === null) return null;
  const flattened = raw.replace(CONTROL_CHARACTERS, '').replace(/\r|\n/g, '').split(/[/\\]/).pop();
  if (flattened === undefined) return null;
  const cleaned = flattened
    .replace(UNSAFE_FILENAME, '_')
    .trim()
    // Leading dots only after trimming, so "  ..  " cannot survive as "..".
    .replace(/^\.+/, '')
    .trim()
    .slice(0, ATTACHMENT_LIMITS.maxFilenameLength)
    .trim();
  return cleaned.length === 0 ? null : cleaned;
}

/** A declared content type reduced to a media type we are willing to store. */
export function safeContentType(raw: string | null): string {
  if (raw === null) return 'application/octet-stream';
  const media = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(media)
    ? media
    : 'application/octet-stream';
}

export interface CheckedAttachment {
  readonly index: number;
  readonly filename: string | null;
  readonly contentType: string;
  readonly content: Uint8Array;
  readonly inline: boolean;
}

export interface RejectedAttachment {
  readonly index: number;
  readonly filename: string | null;
  readonly reason: 'too_large';
  readonly sizeBytes: number;
}

export interface CheckedAttachments {
  readonly accepted: readonly CheckedAttachment[];
  /** Reported, never silently dropped: the case must show what could not be read. */
  readonly rejected: readonly RejectedAttachment[];
}

/**
 * Validates the attachments of a parsed message. A message carrying more
 * attachments than allowed is refused whole, because that shape is hostile
 * rather than merely large. A single oversized attachment is reported and
 * skipped, so the message body and its other attachments still arrive.
 */
export function checkAttachments(
  message: InboundMessage,
): Result<CheckedAttachments, ValidationError> {
  if (message.attachments.length > ATTACHMENT_LIMITS.maxCount) {
    return err(
      new ValidationError(
        'TOO_MANY_ATTACHMENTS',
        'The message carries more attachments than allowed.',
        { details: { count: message.attachments.length, maximum: ATTACHMENT_LIMITS.maxCount } },
      ),
    );
  }
  const accepted: CheckedAttachment[] = [];
  const rejected: RejectedAttachment[] = [];
  for (const attachment of message.attachments) {
    if (attachment.content.byteLength > ATTACHMENT_LIMITS.maxBytes) {
      rejected.push({
        index: attachment.index,
        filename: safeFilename(attachment.filename),
        reason: 'too_large',
        sizeBytes: attachment.content.byteLength,
      });
      continue;
    }
    if (attachment.content.byteLength === 0) continue; // an empty part carries no evidence
    accepted.push(normaliseAttachment(attachment));
  }
  return ok({ accepted, rejected });
}

function normaliseAttachment(attachment: InboundAttachment): CheckedAttachment {
  return {
    index: attachment.index,
    filename: safeFilename(attachment.filename),
    contentType: safeContentType(attachment.contentType),
    content: attachment.content,
    inline: attachment.inline,
  };
}
