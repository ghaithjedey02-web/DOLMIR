import { type DomainError, InfrastructureError } from '../../../../kernel/errors.js';
import { err, ok, type Result } from '../../../../kernel/result.js';
import type { TenantConnection } from '../../domain/connection.js';
import type {
  MailboxConnectorFactory,
  MailboxConnectorPort,
  MailboxCursor,
  MailboxListing,
  MailboxProbe,
  OutboundMessage,
  SentMessage,
} from '../../application/ports.js';

/**
 * A mailbox that lives in memory. It exists so the pipeline can be exercised
 * end to end without a live account, and so the failures a real provider shows
 * can be reproduced deliberately: a mailbox that is down, a message that
 * disappears between listing and fetching, a renumbered mailbox, a refused
 * send. It is a test double, never a product feature.
 */
export const FAKE_MAILBOX_PROVIDER = 'fake_mailbox';

export interface FakeMessage {
  readonly uid: string;
  readonly raw: Uint8Array;
  readonly receivedAt: Date;
  /** Listed, then gone when fetched: the message was moved or deleted meanwhile. */
  readonly vanishes?: boolean;
}

export interface FakeMailboxOptions {
  readonly messages?: readonly FakeMessage[];
  /** Changing it between polls simulates a provider renumbering its messages. */
  readonly generation?: string;
  /** `undefined` clears a previously configured failure, so recovery can be tested. */
  readonly failListing?: DomainError | undefined;
  readonly failFetch?: DomainError | undefined;
  readonly failSend?: DomainError | undefined;
}

export class FakeMailbox implements MailboxConnectorPort {
  readonly provider = FAKE_MAILBOX_PROVIDER;
  readonly sent: OutboundMessage[] = [];
  readonly fetched: string[] = [];
  closed = false;
  private options: FakeMailboxOptions;

  constructor(options: FakeMailboxOptions = {}) {
    this.options = options;
  }

  /** Delivers more mail, or changes how the provider behaves, between polls. */
  configure(options: FakeMailboxOptions): void {
    this.options = { ...this.options, ...options };
  }

  private get messages(): readonly FakeMessage[] {
    return this.options.messages ?? [];
  }

  private get generation(): string {
    return this.options.generation ?? '1';
  }

  async test(): Promise<Result<MailboxProbe, DomainError>> {
    if (this.options.failListing !== undefined) return err(this.options.failListing);
    return ok({
      provider: this.provider,
      mailbox: 'INBOX',
      messageCount: this.messages.length,
    });
  }

  async listNew(
    cursor: MailboxCursor,
    limit: number,
  ): Promise<Result<MailboxListing, DomainError>> {
    if (this.options.failListing !== undefined) return err(this.options.failListing);
    const reset = cursor.generation !== null && cursor.generation !== this.generation;
    const after = reset || cursor.lastUid === null ? null : cursor.lastUid;
    const messages = this.messages
      .filter((message) => after === null || Number(message.uid) > Number(after))
      .slice(0, limit)
      .map((message) => ({
        uid: message.uid,
        receivedAt: message.receivedAt,
        sizeBytes: message.raw.byteLength,
      }));
    return ok({
      messages,
      cursor: { generation: this.generation, lastUid: cursor.lastUid },
      reset,
    });
  }

  async fetchRaw(uid: string): Promise<Result<Uint8Array | undefined, DomainError>> {
    if (this.options.failFetch !== undefined) return err(this.options.failFetch);
    this.fetched.push(uid);
    const message = this.messages.find((item) => item.uid === uid);
    if (message === undefined || message.vanishes === true) return ok(undefined);
    return ok(message.raw);
  }

  async send(message: OutboundMessage): Promise<Result<SentMessage, DomainError>> {
    if (this.options.failSend !== undefined) return err(this.options.failSend);
    this.sent.push(message);
    return ok({
      messageId: `fake-${String(this.sent.length)}@dolmir.test`,
      acceptedAt: new Date(),
    });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Hands out one fake mailbox per connection, so a test can inspect it afterwards. */
export class FakeMailboxFactory implements MailboxConnectorFactory {
  readonly mailboxes = new Map<string, FakeMailbox>();
  private readonly defaults: FakeMailboxOptions;

  constructor(defaults: FakeMailboxOptions = {}) {
    this.defaults = defaults;
  }

  supports(provider: string): boolean {
    return provider === FAKE_MAILBOX_PROVIDER;
  }

  create(connection: TenantConnection): Result<MailboxConnectorPort, DomainError> {
    if (!this.supports(connection.provider)) {
      return err(
        new InfrastructureError(
          'UNSUPPORTED_PROVIDER',
          `No connector implements provider "${connection.provider}".`,
        ),
      );
    }
    const existing = this.mailboxes.get(connection.id);
    if (existing !== undefined) return ok(existing);
    const mailbox = new FakeMailbox(this.defaults);
    this.mailboxes.set(connection.id, mailbox);
    return ok(mailbox);
  }

  /** The mailbox a connection uses, creating it if the connector was never built. */
  for(connectionId: string): FakeMailbox {
    const existing = this.mailboxes.get(connectionId);
    if (existing !== undefined) return existing;
    const mailbox = new FakeMailbox(this.defaults);
    this.mailboxes.set(connectionId, mailbox);
    return mailbox;
  }
}
