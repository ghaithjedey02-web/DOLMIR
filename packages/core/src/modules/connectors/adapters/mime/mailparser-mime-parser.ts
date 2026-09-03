import { type AddressObject, type Attachment, type ParsedMail, simpleParser } from 'mailparser';

import { InfrastructureError } from '../../../../kernel/errors.js';
import { err, ok, type Result } from '../../../../kernel/result.js';
import type { MimeParserPort } from '../../application/ports.js';
import {
  type InboundAttachment,
  type InboundMessage,
  type MailAddress,
  normaliseEmailAddress,
  stripAngleBrackets,
} from '../../domain/inbound-message.js';

/**
 * MIME parsing behind the port (ADR-0013). The vendor library appears here and
 * nowhere else, and its objects never leave this file: callers receive the
 * canonical `InboundMessage`.
 *
 * Every field is treated as attacker-controlled. Nothing is fetched, no link
 * is followed, no archive is opened, and a malformed message becomes a typed
 * failure rather than an exception.
 */
export class MailparserMimeParser implements MimeParserPort {
  readonly name = 'mailparser';

  async parse(raw: Uint8Array): Promise<Result<InboundMessage, InfrastructureError>> {
    let parsed: ParsedMail;
    try {
      parsed = await simpleParser(Buffer.from(raw), {
        // No derived bodies and no link rewriting: what arrived is what we keep.
        skipHtmlToText: true,
        skipTextToHtml: true,
        skipImageLinks: true,
      });
    } catch (error) {
      return err(
        new InfrastructureError('MALFORMED_MESSAGE', 'The message could not be parsed as MIME.', {
          cause: error,
          details: { reason: error instanceof Error ? error.name : 'unknown' },
        }),
      );
    }
    return ok(toInboundMessage(parsed));
  }
}

function toInboundMessage(parsed: ParsedMail): InboundMessage {
  return {
    messageId: parsed.messageId === undefined ? null : stripAngleBrackets(parsed.messageId),
    from: firstAddress(parsed.from),
    replyTo: addresses(parsed.replyTo),
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    subject: emptyToNull(parsed.subject),
    date: parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : null,
    inReplyTo: parsed.inReplyTo === undefined ? null : stripAngleBrackets(parsed.inReplyTo),
    references: references(parsed.references),
    text: emptyToNull(parsed.text),
    html: typeof parsed.html === 'string' ? emptyToNull(parsed.html) : null,
    attachments: parsed.attachments.map(toAttachment),
  };
}

function toAttachment(attachment: Attachment, index: number): InboundAttachment {
  return {
    index,
    filename: emptyToNull(attachment.filename),
    contentType: attachment.contentType,
    content: Uint8Array.from(attachment.content),
    // `related` marks a part the HTML body references, such as an inline image.
    inline: attachment.related || attachment.contentDisposition === 'inline',
    contentId: attachment.cid === undefined ? null : stripAngleBrackets(attachment.cid),
  };
}

function addresses(value: AddressObject | AddressObject[] | undefined): MailAddress[] {
  if (value === undefined) return [];
  const objects = Array.isArray(value) ? value : [value];
  const result: MailAddress[] = [];
  for (const object of objects) {
    for (const entry of object.value) {
      if (entry.address === undefined || entry.address.trim().length === 0) continue;
      result.push({
        address: normaliseEmailAddress(entry.address),
        // A display name is whatever the sender chose to write. It is a label, never an identity.
        name: emptyToNull(entry.name),
      });
    }
  }
  return result;
}

function firstAddress(value: AddressObject | undefined): MailAddress | null {
  return addresses(value)[0] ?? null;
}

function references(value: string[] | string | undefined): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : value.split(/\s+/);
  return list.map(stripAngleBrackets).filter((entry) => entry.length > 0);
}

function emptyToNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
