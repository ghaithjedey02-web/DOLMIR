import { z } from 'zod';

import { OrganizationIdSchema, UserIdSchema, UuidSchema } from '../../../kernel/ids.js';

/**
 * Company rules: typed, versioned, governed (Direction §13–§14). Every change
 * is a new version row — the history is the audit of how the company told
 * DOLMIR to behave. A rule with a `null` value is unset. Rule *definitions*
 * (key, meaning, value schema) are registered in code by Core and by AI
 * Systems; a value is accepted only if it satisfies its definition.
 */
export const RuleKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/, 'snake_case, dot separated');

export const CompanyRuleSchema = z
  .object({
    id: UuidSchema,
    organizationId: OrganizationIdSchema,
    key: RuleKeySchema,
    /** The value, validated against the rule definition; `null` unsets the rule. */
    value: z.unknown(),
    /** Why this value, in the company's words. */
    rationale: z.string().trim().min(1).max(2000).nullable(),
    version: z.number().int().min(1),
    createdAt: z.date(),
    createdBy: UserIdSchema.nullable(),
  })
  .strict();
export type CompanyRule = z.infer<typeof CompanyRuleSchema>;

export interface RuleDefinition<T = unknown> {
  readonly key: string;
  readonly description: string;
  readonly schema: z.ZodType<T>;
  /** Which system owns it; `core` for shared rules. */
  readonly owner: string;
}

/** Registry of rule definitions; systems register theirs at composition time. */
export class RuleRegistry {
  private readonly definitions = new Map<string, RuleDefinition>();

  register<T>(definition: RuleDefinition<T>): this {
    if (this.definitions.has(definition.key)) {
      throw new Error(`Rule "${definition.key}" is already defined.`);
    }
    this.definitions.set(definition.key, definition);
    return this;
  }

  get(key: string): RuleDefinition | undefined {
    return this.definitions.get(key);
  }

  list(): readonly RuleDefinition[] {
    return [...this.definitions.values()].sort((a, b) => a.key.localeCompare(b.key));
  }
}

/** Rules every deployment understands. Systems add their own. */
export const CORE_RULES: readonly RuleDefinition[] = [
  {
    key: 'reply_language',
    description: 'Language of outgoing drafts when the counterpart does not impose one.',
    schema: z.enum(['it', 'en', 'de', 'fr', 'es']),
    owner: 'core',
  },
  {
    key: 'response_sla_hours',
    description: 'Hours within which an inbound request should receive a first answer.',
    schema: z.number().int().min(1).max(720),
    owner: 'core',
  },
  {
    key: 'working_days',
    description: 'ISO weekday numbers (1 = Monday) on which the company operates.',
    schema: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    owner: 'core',
  },
  {
    key: 'escalation_contact',
    description: 'Who is told when something needs a human decision and nobody is assigned.',
    schema: z.email(),
    owner: 'core',
  },
];
