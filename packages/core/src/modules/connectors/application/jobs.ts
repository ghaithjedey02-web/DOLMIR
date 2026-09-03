import { z } from 'zod';

import { OrganizationIdSchema, ConnectionIdSchema } from '../../../kernel/ids.js';
import { defineJob } from '../../../kernel/jobs.js';

/**
 * Background work the connectors module owns (ADR-0014). Payloads are
 * references only: a poll names a tenant and a connection, never a message.
 * The handler re-enters the tenant's scope before touching any data.
 */
export const mailboxPollJob = defineJob({
  name: 'mailbox.poll',
  payload: z.object({ tenantId: OrganizationIdSchema, connectionId: ConnectionIdSchema }).strict(),
  retryLimit: 3,
  retryDelaySeconds: 60,
  expireInSeconds: 10 * 60,
});

/** Enqueues one poll per active mailbox connection; runs in system scope and is audited. */
export const mailboxScheduleJob = defineJob({
  name: 'mailbox.schedule_polls',
  payload: z.object({}).strict(),
  retryLimit: 1,
  retryDelaySeconds: 30,
  expireInSeconds: 5 * 60,
});
