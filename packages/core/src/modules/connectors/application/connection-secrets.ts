import {
  type DomainError,
  NotFoundError,
  PreconditionFailedError,
} from '../../../kernel/errors.js';
import type { ConnectionId } from '../../../kernel/ids.js';
import { err, ok, type Result } from '../../../kernel/result.js';
import type { TenantScope } from '../../../kernel/scope.js';
import type { CredentialCipher } from '../domain/credential-cipher.js';
import type { TenantConnection } from '../domain/connection.js';
import type { ConnectionRepository } from './ports.js';

/**
 * The only path from a stored connection to usable credentials. Plaintext
 * exists inside this call and inside the adapter it is handed to; it is never
 * returned by the API, never logged and never written to the ledger.
 */
export interface ConnectionSecretsDependencies {
  readonly connections: ConnectionRepository;
  readonly cipher: CredentialCipher;
}

export interface OpenedConnection {
  readonly connection: TenantConnection;
  readonly credentials: Readonly<Record<string, unknown>>;
}

export class ConnectionSecrets {
  private readonly deps: ConnectionSecretsDependencies;

  constructor(deps: ConnectionSecretsDependencies) {
    this.deps = deps;
  }

  /** Loads an active connection and decrypts its credentials for the caller's tenant only. */
  async open(scope: TenantScope, id: ConnectionId): Promise<Result<OpenedConnection, DomainError>> {
    const connection = await this.deps.connections.findById(scope, id);
    if (connection === undefined) {
      return err(new NotFoundError('CONNECTION_NOT_FOUND', 'The connection was not found.'));
    }
    return this.openConnection(connection);
  }

  openConnection(connection: TenantConnection): Result<OpenedConnection, DomainError> {
    if (connection.status === 'disabled') {
      return err(
        new PreconditionFailedError('CONNECTION_DISABLED', 'The connection is disabled.', {
          details: { connectionId: connection.id },
        }),
      );
    }
    const credentials = this.deps.cipher.decrypt(connection.organizationId, connection.credentials);
    if (!credentials.ok) return err(credentials.error);
    return ok({ connection, credentials: credentials.value });
  }
}
