import { ImapFlow } from 'imapflow';
import { createTransport, type Transporter } from 'nodemailer';
import { z } from 'zod';

import {
  type DomainError,
  InfrastructureError,
  ValidationError,
  validationErrorFromZod,
} from '../../../../kernel/errors.js';
import { err, ok, type Result } from '../../../../kernel/result.js';
import type { TenantConnection } from '../../domain/connection.js';
import type {
  MailboxConnectorFactory,
  MailboxConnectorPort,
  MailboxCursor,
  MailboxListing,
  MailboxMessageRef,
  MailboxProbe,
  OutboundMessage,
  SentMessage,
} from '../../application/ports.js';

/**
 * The first mailbox provider (ADR-0013 §3b): IMAP to read and SMTP to send.
 * It is the common denominator of Google Workspace, Microsoft 365 and the
 * hosted providers Italian SMEs use, so one adapter reaches most customers.
 * Gmail API and Microsoft Graph adapters implement the same port later, and
 * nothing above this file changes when they arrive.
 *
 * Honesty about verification: this adapter is exercised against a fake client
 * in the test suite. Running it against a live mailbox needs a real account
 * and is a deployment task, not something the test suite can claim.
 */
export const IMAP_SMTP_PROVIDER = 'imap_smtp';

const HostSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  /** Implicit TLS. When false the adapter still requires STARTTLS. */
  secure: z.boolean().default(true),
});

export const ImapSmtpSettingsSchema = z
  .object({
    imap: HostSchema,
    smtp: HostSchema,
    mailbox: z.string().trim().min(1).max(200).default('INBOX'),
    /** Address replies are sent from. */
    from: z.email(),
    /**
     * How far back the first poll reaches. Zero means only mail that arrives
     * after the connection is created, which is the safe default: a customer
     * connecting a ten-year-old mailbox does not want it ingested wholesale.
     */
    initialLookbackDays: z.number().int().min(0).max(30).default(0),
  })
  .strict();
export type ImapSmtpSettings = z.infer<typeof ImapSmtpSettingsSchema>;

export const ImapSmtpCredentialsSchema = z
  .object({
    user: z.string().trim().min(1).max(320),
    /** An application password, or the access token of an OAuth flow. */
    pass: z.string().min(1).optional(),
    accessToken: z.string().min(1).optional(),
  })
  .strict()
  .refine((value) => value.pass !== undefined || value.accessToken !== undefined, {
    message: 'either pass or accessToken is required',
  });
export type ImapSmtpCredentials = z.infer<typeof ImapSmtpCredentialsSchema>;

/** Every network call is bounded, so a hung provider fails the job instead of holding it. */
export const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;

export interface ImapSmtpConnectorOptions {
  readonly settings: ImapSmtpSettings;
  readonly credentials: ImapSmtpCredentials;
  readonly timeoutMs?: number;
  /** Injected in tests; production uses the real libraries. */
  readonly clients?: MailClients;
}

/** The two vendor clients, behind the narrowest interfaces this adapter uses. */
export interface ImapClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  getMailboxLock(path: string): Promise<{ release: () => void }>;
  status(
    path: string,
    query: { messages?: boolean; uidNext?: boolean; uidValidity?: boolean },
  ): Promise<{ messages?: number; uidNext?: number; uidValidity?: bigint }>;
  fetchAll(
    range: string,
    query: { uid?: boolean; internalDate?: boolean; size?: boolean; source?: boolean },
    options?: { uid?: boolean },
  ): Promise<{ uid: number; internalDate?: Date | string; size?: number; source?: Buffer }[]>;
}

export interface SmtpClientLike {
  sendMail(message: {
    from: string;
    to: string;
    cc?: string;
    subject: string;
    text: string;
    html?: string;
    inReplyTo?: string;
    references?: string[];
  }): Promise<{ messageId: string }>;
}

export interface MailClients {
  imap(options: ImapSmtpConnectorOptions): ImapClientLike;
  smtp(options: ImapSmtpConnectorOptions): SmtpClientLike;
}

export class ImapSmtpConnector implements MailboxConnectorPort {
  readonly provider = IMAP_SMTP_PROVIDER;
  private readonly options: ImapSmtpConnectorOptions;
  private readonly clients: MailClients;
  private readonly timeoutMs: number;
  private imap: ImapClientLike | undefined;

  constructor(options: ImapSmtpConnectorOptions) {
    this.options = options;
    this.clients = options.clients ?? realClients;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  }

  async test(): Promise<Result<MailboxProbe, DomainError>> {
    return this.withMailbox(async (client) => {
      const status = await client.status(this.options.settings.mailbox, { messages: true });
      return {
        provider: this.provider,
        mailbox: this.options.settings.mailbox,
        messageCount: status.messages ?? 0,
      };
    });
  }

  async listNew(
    cursor: MailboxCursor,
    limit: number,
  ): Promise<Result<MailboxListing, DomainError>> {
    return this.withMailbox(async (client) => {
      const status = await client.status(this.options.settings.mailbox, {
        uidNext: true,
        uidValidity: true,
      });
      const generation = status.uidValidity === undefined ? null : String(status.uidValidity);
      const uidNext = status.uidNext ?? 1;
      // A provider that renumbers its messages invalidates every stored uid.
      const reset = cursor.generation !== null && cursor.generation !== generation;
      const from = startUid(cursor, reset, uidNext, this.options.settings.initialLookbackDays);
      if (from >= uidNext) {
        return { messages: [], cursor: { generation, lastUid: cursor.lastUid }, reset };
      }
      const fetched = await client.fetchAll(
        `${String(from)}:*`,
        { uid: true, internalDate: true, size: true },
        { uid: true },
      );
      const messages: MailboxMessageRef[] = fetched
        // `n:*` always yields the last message, even when no uid reaches n.
        .filter((item) => item.uid >= from)
        .sort((a, b) => a.uid - b.uid)
        .slice(0, limit)
        .map((item) => ({
          uid: String(item.uid),
          receivedAt: toDate(item.internalDate),
          sizeBytes: item.size ?? 0,
        }));
      return { messages, cursor: { generation, lastUid: cursor.lastUid }, reset };
    });
  }

  async fetchRaw(uid: string): Promise<Result<Uint8Array | undefined, DomainError>> {
    return this.withMailbox(async (client) => {
      const found = await client.fetchAll(uid, { uid: true, source: true }, { uid: true });
      const source = found[0]?.source;
      return source === undefined ? undefined : Uint8Array.from(source);
    });
  }

  async send(message: OutboundMessage): Promise<Result<SentMessage, DomainError>> {
    const recipients = message.to.filter((address) => address.trim().length > 0);
    if (recipients.length === 0) {
      return err(new ValidationError('NO_RECIPIENT', 'The message names no recipient.'));
    }
    try {
      const client = this.clients.smtp(this.options);
      const sent = await this.bounded(
        client.sendMail({
          from: this.options.settings.from,
          to: recipients.join(', '),
          ...(message.cc === undefined || message.cc.length === 0
            ? {}
            : { cc: message.cc.join(', ') }),
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
          ...(message.inReplyTo === undefined ? {} : { inReplyTo: angled(message.inReplyTo) }),
          ...(message.references === undefined || message.references.length === 0
            ? {}
            : { references: message.references.map(angled) }),
          // Derived from the authorised action rather than generated, so every
          // attempt at the same send carries the same Message-ID and a
          // duplicate keeps one identity for clients that collapse on it.
          ...(message.idempotencyKey === undefined
            ? {}
            : {
                messageId: deterministicMessageId(
                  message.idempotencyKey,
                  this.options.settings.from,
                ),
              }),
        }),
        'smtp.send',
      );
      return ok({ messageId: stripAngles(sent.messageId), acceptedAt: new Date() });
    } catch (error) {
      return err(mailError('SMTP_SEND_FAILED', 'The message could not be sent.', error));
    }
  }

  async close(): Promise<void> {
    const client = this.imap;
    this.imap = undefined;
    if (client === undefined) return;
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }

  private async withMailbox<T>(
    fn: (client: ImapClientLike) => Promise<T>,
  ): Promise<Result<T, DomainError>> {
    try {
      const client = await this.connected();
      const lock = await this.bounded(
        client.getMailboxLock(this.options.settings.mailbox),
        'imap.open',
      );
      try {
        return ok(await this.bounded(fn(client), 'imap.command'));
      } finally {
        lock.release();
      }
    } catch (error) {
      return err(mailError('IMAP_UNAVAILABLE', 'The mailbox could not be reached.', error));
    }
  }

  private async connected(): Promise<ImapClientLike> {
    if (this.imap !== undefined) return this.imap;
    const client = this.clients.imap(this.options);
    await this.bounded(client.connect(), 'imap.connect');
    this.imap = client;
    return client;
  }

  private async bounded<T>(work: Promise<T>, operation: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new InfrastructureError('MAILBOX_TIMEOUT', `${operation} did not answer in time.`, {
            retryable: true,
            details: { operation, timeoutMs: this.timeoutMs },
          }),
        );
      }, this.timeoutMs);
      // Keeps a pending timeout from holding the process open.
      timer.unref();
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/** Builds connectors for the IMAP and SMTP provider from a stored connection. */
export class ImapSmtpConnectorFactory implements MailboxConnectorFactory {
  private readonly clients: MailClients | undefined;
  private readonly timeoutMs: number | undefined;

  constructor(options: { readonly clients?: MailClients; readonly timeoutMs?: number } = {}) {
    this.clients = options.clients;
    this.timeoutMs = options.timeoutMs;
  }

  supports(provider: string): boolean {
    return provider === IMAP_SMTP_PROVIDER;
  }

  create(
    connection: TenantConnection,
    credentials: Readonly<Record<string, unknown>>,
  ): Result<MailboxConnectorPort, DomainError> {
    const settings = ImapSmtpSettingsSchema.safeParse(connection.settings);
    if (!settings.success) {
      return err(
        validationErrorFromZod(
          settings.error,
          'INVALID_CONNECTION_SETTINGS',
          'The mailbox settings are incomplete.',
        ),
      );
    }
    const parsedCredentials = ImapSmtpCredentialsSchema.safeParse(credentials);
    if (!parsedCredentials.success) {
      // The issues name the missing fields; no value from the credentials is echoed.
      return err(
        new ValidationError(
          'INVALID_CONNECTION_CREDENTIALS',
          'The mailbox credentials are incomplete.',
          { details: { fields: Object.keys(credentials).sort() } },
        ),
      );
    }
    return ok(
      new ImapSmtpConnector({
        settings: settings.data,
        credentials: parsedCredentials.data,
        ...(this.clients === undefined ? {} : { clients: this.clients }),
        ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
      }),
    );
  }
}

const realClients: MailClients = {
  imap(options) {
    const { settings, credentials } = options;
    return new ImapFlow({
      host: settings.imap.host,
      port: settings.imap.port,
      secure: settings.imap.secure,
      auth: {
        user: credentials.user,
        ...(credentials.pass === undefined ? {} : { pass: credentials.pass }),
        ...(credentials.accessToken === undefined ? {} : { accessToken: credentials.accessToken }),
      },
      // The vendor logger would print message metadata; the platform logger is used instead.
      logger: false,
    });
  },
  smtp(options) {
    const { settings, credentials } = options;
    const transport: Transporter = createTransport({
      host: settings.smtp.host,
      port: settings.smtp.port,
      secure: settings.smtp.secure,
      // Plaintext SMTP is never acceptable for credentials or customer content.
      requireTLS: true,
      auth: {
        user: credentials.user,
        ...(credentials.pass === undefined ? {} : { pass: credentials.pass }),
        ...(credentials.accessToken === undefined
          ? { type: undefined }
          : { type: 'OAuth2' as const, accessToken: credentials.accessToken }),
      },
    });
    return transport;
  },
};

/**
 * Where the first poll starts. A new connection begins at the next uid, so
 * connecting a mailbox does not ingest its history; a lookback is an explicit
 * per-connection setting. After a renumbering the same rule applies.
 */
function startUid(
  cursor: MailboxCursor,
  reset: boolean,
  uidNext: number,
  lookbackDays: number,
): number {
  if (!reset && cursor.lastUid !== null) {
    const parsed = Number.parseInt(cursor.lastUid, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed + 1;
  }
  // Without a cursor there is no uid to resume from; a lookback is approximated
  // by a window of uids and refined by the receivedAt of each message.
  return lookbackDays > 0 ? Math.max(1, uidNext - lookbackDays * 200) : uidNext;
}

function toDate(value: Date | string | undefined): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function angled(value: string): string {
  return value.startsWith('<') ? value : `<${value}>`;
}

function stripAngles(value: string): string {
  return value.replace(/^<|>$/g, '');
}

function mailError(code: string, message: string, cause: unknown): DomainError {
  if (cause instanceof InfrastructureError) return cause;
  return new InfrastructureError(code, message, {
    cause,
    retryable: true,
    // The provider's message can name a host; it never carries the credentials.
    details: { reason: cause instanceof Error ? cause.message.slice(0, 200) : 'unknown' },
  });
}

/**
 * `<dolmir.<key>@<sending domain>>`. Stable for a given authorised action, and
 * a legal RFC 5322 message identifier: the local part is restricted to
 * characters an atom allows, and the domain is the address the mailbox sends
 * from, so the identifier is globally unique to this company and this action.
 */
export function deterministicMessageId(idempotencyKey: string, from: string): string {
  const domain = from.split('@').at(-1) ?? 'dolmir.invalid';
  const local = idempotencyKey.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120);
  return `<dolmir.${local}@${domain}>`;
}
