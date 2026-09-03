/**
 * The canonical inbound message every mailbox provider produces and every
 * consumer reads: parsed once, provider-agnostic, never a vendor object.
 * Bytes of attachments stay bytes; the raw MIME is kept in object storage by
 * the ingestion use case for evidence and re-processing.
 */
export interface MailAddress {
  readonly address: string;
  readonly name: string | null;
}

export interface InboundAttachment {
  /** Position in the message, stable across re-parses of the same bytes. */
  readonly index: number;
  readonly filename: string | null;
  readonly contentType: string;
  readonly content: Uint8Array;
  /** Referenced from the HTML body (an inline image), not a real attachment. */
  readonly inline: boolean;
  readonly contentId: string | null;
}

export interface InboundMessage {
  /** RFC 5322 Message-ID without the angle brackets, when present. */
  readonly messageId: string | null;
  readonly from: MailAddress | null;
  readonly replyTo: readonly MailAddress[];
  readonly to: readonly MailAddress[];
  readonly cc: readonly MailAddress[];
  readonly subject: string | null;
  readonly date: Date | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly text: string | null;
  readonly html: string | null;
  readonly attachments: readonly InboundAttachment[];
}

/** Larger messages are refused at the boundary; nothing is partially ingested. */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

export function normaliseEmailAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function stripAngleBrackets(value: string): string {
  return value.trim().replace(/^<|>$/g, '');
}

/** Source facts stored on the e-mail document. Never secrets, never bodies. */
export function messageMetadata(message: InboundMessage): Record<string, unknown> {
  const address = (item: MailAddress): { address: string; name: string | null } => ({
    address: item.address,
    name: item.name,
  });
  return {
    messageId: message.messageId,
    from: message.from === null ? null : address(message.from),
    replyTo: message.replyTo.map(address),
    to: message.to.map(address),
    cc: message.cc.map(address),
    subject: message.subject,
    date: message.date === null ? null : message.date.toISOString(),
    inReplyTo: message.inReplyTo,
    references: [...message.references],
    attachments: message.attachments.map((attachment) => ({
      index: attachment.index,
      filename: attachment.filename,
      contentType: attachment.contentType,
      sizeBytes: attachment.content.byteLength,
      inline: attachment.inline,
    })),
  };
}
