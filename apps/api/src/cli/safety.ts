import {
  ACTION_POLICY_VERSION,
  DEFAULT_EFFECT_LEVELS,
  HUMAN_ONLY_PERMISSIONS,
  type OrganizationId,
  PersistedActionPolicy,
  PolicyLevel,
  type PolicyOverride,
  PostgresPolicyOverrideRepository,
  type TenantConnection,
  type ToolDescriptor,
  ToolEffect,
  inspectJobQueue,
} from '@dolmir/core';

import type { Container } from '../composition/container.js';
import { PLATFORM_JOBS } from '../composition/jobs.js';

/**
 * `dolmir safety` — could the AI cause anything to happen outside DOLMIR
 * without a person deciding it should?
 *
 * The report walks the chain an external effect would have to travel: a tool
 * whose effect is `act`; a policy that lets it run, and at what level; a
 * tenant with somewhere to send to; and a schedule that would set the whole
 * thing in motion unattended. It reads and reports. It writes nothing except
 * the audit row the platform itself insists on whenever a system scope is
 * opened, which is how this very report leaves a trace.
 *
 * `unsafe` names the conditions under which an action could complete with no
 * human approval. An active mailbox on its own is not one of them: with
 * `REQUIRE_APPROVAL` it means a person can send a reply, which is the
 * supervised phase working as designed.
 */
export interface SafetySection {
  readonly title: string;
  readonly lines: readonly string[];
}

export interface SafetyReport {
  readonly sections: readonly SafetySection[];
  readonly unsafe: readonly string[];
  readonly ok: boolean;
}

const SYSTEM_SCOPE_REASON = 'safety_posture_report';

export async function runSafety(container: Container): Promise<SafetyReport> {
  const sections: SafetySection[] = [];
  const unsafe: string[] = [];

  // ---- the code's own defaults --------------------------------------------
  const defaults = Object.entries(DEFAULT_EFFECT_LEVELS).map(
    ([effect, level]) => `${effect.padEnd(8)} → ${level}`,
  );
  for (const [effect, level] of Object.entries(DEFAULT_EFFECT_LEVELS)) {
    if (level === PolicyLevel.AUTO_EXECUTE) {
      unsafe.push(`the code default for effect "${effect}" is AUTO_EXECUTE`);
    }
  }
  sections.push({
    title: `Action policy — code defaults, version ${String(ACTION_POLICY_VERSION)}`,
    lines: [...defaults, 'AUTO_EXECUTE is not the default for any effect'],
  });

  sections.push({
    title: 'Permissions no AI actor can ever hold',
    lines: [...HUMAN_ONLY_PERMISSIONS].sort().map((permission) => permission),
  });

  // ---- the tools that could act ------------------------------------------
  const acting = container.ai.tools.describe().filter((tool) => tool.effect === ToolEffect.ACT);
  sections.push({
    title: 'Tools whose effect is act',
    lines:
      acting.length === 0
        ? ['none registered']
        : acting.map((tool) => `${tool.name}  (requires ${tool.permission})`),
  });

  // ---- what the database says, across tenants -----------------------------
  const overrideRepository = new PostgresPolicyOverrideRepository();
  const { overrides, mailboxes } = await container.transactions.withSystemScope(
    SYSTEM_SCOPE_REASON,
    async (scope) => ({
      overrides: await overrideRepository.list(scope),
      mailboxes: await container.connectors.connections.listActiveAcrossTenants(
        scope,
        'mailbox',
        500,
      ),
    }),
  );

  sections.push({
    title: 'Policy overrides — every tenant',
    lines:
      overrides.length === 0
        ? ['none: every tenant runs on the code defaults']
        : overrides.map(describeOverride),
  });
  for (const override of overrides) {
    if (override.level === PolicyLevel.AUTO_EXECUTE) {
      unsafe.push(
        `organisation ${override.organizationId} overrides ${override.subjectKind} "${override.subject}" to AUTO_EXECUTE`,
      );
    }
  }

  sections.push({
    title: 'Active mailbox connections — every tenant',
    lines:
      mailboxes.length === 0
        ? ['none: no reply can be drafted or sent for any tenant']
        : mailboxes.map(describeConnection),
  });

  // For each tenant that has somewhere to send to, what would actually happen
  // if the AI recommended it — resolved by the same policy the executor uses.
  const tenants = [...new Set(mailboxes.map((connection) => connection.organizationId))];
  if (tenants.length > 0 && acting.length > 0) {
    const policy = new PersistedActionPolicy({
      transactions: container.transactions,
      overrides: overrideRepository,
    });
    const lines: string[] = [];
    for (const tenantId of tenants) {
      for (const tool of acting) {
        lines.push(await describeEffectiveLevel(policy, tenantId, tool, unsafe));
      }
    }
    sections.push({
      title: 'Effective level of each acting tool, per tenant with a mailbox',
      lines,
    });
  }

  // ---- what runs unattended ----------------------------------------------
  if (container.config.jobs.driver === 'pg-boss') {
    const inspection = await inspectJobQueue(container.pool, {
      schema: container.config.jobs.schema,
      jobs: PLATFORM_JOBS,
    });
    const lines = !inspection.schemaPresent
      ? [`schema ${inspection.schema} is not installed: nothing is scheduled`]
      : inspection.schedules.length === 0
        ? ['none']
        : inspection.schedules.map(
            (schedule) =>
              `${schedule.name}${schedule.key === '' ? '' : ` [${schedule.key}]`}  ${schedule.cron}${
                schedule.timezone === null ? '' : ` ${schedule.timezone}`
              }`,
          );
    sections.push({ title: 'Scheduled jobs — what the queue enqueues on its own', lines });
    for (const schedule of inspection.schedules) {
      if (schedule.name.startsWith('mailbox.')) {
        unsafe.push(`a mailbox job is scheduled: ${schedule.name} (${schedule.cron})`);
      }
    }
  } else {
    sections.push({
      title: 'Scheduled jobs — what the queue enqueues on its own',
      lines: [
        'in-memory queue: schedules exist only inside the running API process',
        'expected there: cases.recover_executions and nothing else',
      ],
    });
  }

  return { sections, unsafe, ok: unsafe.length === 0 };
}

function describeOverride(override: PolicyOverride): string {
  const level = override.level ?? 'cleared → default applies';
  const by = override.updatedBy === null ? '' : ` by ${override.updatedBy}`;
  return `organisation ${override.organizationId}  ${override.subjectKind}:${override.subject} → ${level}  (${override.updatedAt.toISOString()}${by})`;
}

/** Identity and provider only. Settings can name addresses and hosts; credentials are never read. */
function describeConnection(connection: TenantConnection): string {
  return `organisation ${connection.organizationId}  connection ${connection.id}  ${connection.provider}  "${connection.displayName}"`;
}

async function describeEffectiveLevel(
  policy: PersistedActionPolicy,
  tenantId: OrganizationId,
  tool: ToolDescriptor,
  unsafe: string[],
): Promise<string> {
  const resolved = await policy.resolve(tenantId, { name: tool.name, effect: tool.effect });
  const meaning =
    resolved.level === PolicyLevel.AUTO_EXECUTE
      ? 'RUNS WITHOUT A HUMAN'
      : resolved.level === PolicyLevel.REQUIRE_APPROVAL
        ? 'runs only after a human approves'
        : 'cannot run';
  if (resolved.level === PolicyLevel.AUTO_EXECUTE) {
    unsafe.push(
      `organisation ${tenantId}: ${tool.name} resolves to AUTO_EXECUTE (${resolved.source})`,
    );
  }
  return `organisation ${tenantId}  ${tool.name} → ${resolved.level} (${resolved.source}): ${meaning}`;
}
