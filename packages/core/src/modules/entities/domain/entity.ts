import { z } from 'zod';

import { EntityIdSchema, OrganizationIdSchema, UuidSchema } from '../../../kernel/ids.js';

/**
 * Business entities the company deals with (RESOLVE stage, ADR-0012):
 * customers, suppliers, contacts, products. Generic across AI Systems; a
 * system decides which kinds it needs. Aliases are the resolvable handles
 * (e-mail, domain, VAT number, code, normalised name); resolution never
 * guesses beyond them.
 */
export const EntityKind = {
  CUSTOMER: 'customer',
  SUPPLIER: 'supplier',
  CONTACT: 'contact',
  PRODUCT: 'product',
} as const;
export const EntityKindSchema = z.enum(['customer', 'supplier', 'contact', 'product']);
export type EntityKind = z.infer<typeof EntityKindSchema>;

export const EntityStatusSchema = z.enum(['active', 'archived']);
export type EntityStatus = z.infer<typeof EntityStatusSchema>;

const entityShape = {
  organizationId: OrganizationIdSchema,
  kind: EntityKindSchema,
  name: z.string().trim().min(1).max(300),
  /** The company's own code for it (ERP customer code, article code). */
  code: z.string().trim().min(1).max(100).nullable(),
  /** Free structured facts (address, payment terms…); never secrets. */
  attributes: z.record(z.string(), z.unknown()),
};

export const EntitySchema = z
  .object({
    ...entityShape,
    id: EntityIdSchema,
    status: EntityStatusSchema,
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();
export type Entity = z.infer<typeof EntitySchema>;

export const NewEntitySchema = z
  .object({
    ...entityShape,
    code: z.string().trim().min(1).max(100).nullable().default(null),
    attributes: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type NewEntity = z.infer<typeof NewEntitySchema>;
export type NewEntityInput = z.input<typeof NewEntitySchema>;

export const EntityAliasKind = {
  NAME: 'name',
  EMAIL: 'email',
  EMAIL_DOMAIN: 'email_domain',
  VAT: 'vat',
  CODE: 'code',
} as const;
export const EntityAliasKindSchema = z.enum(['name', 'email', 'email_domain', 'vat', 'code']);
export type EntityAliasKind = z.infer<typeof EntityAliasKindSchema>;

export const EntityAliasSchema = z
  .object({
    id: UuidSchema,
    organizationId: OrganizationIdSchema,
    entityId: EntityIdSchema,
    kind: EntityAliasKindSchema,
    /** Normalised with `normaliseAliasValue`; unique per tenant and kind. */
    value: z.string().min(1).max(320),
    /** The value as it was provided, for display. */
    display: z.string().min(1).max(320),
    createdAt: z.date(),
  })
  .strict();
export type EntityAlias = z.infer<typeof EntityAliasSchema>;

export interface NewEntityAlias {
  readonly entityId: Entity['id'];
  readonly kind: EntityAliasKind;
  readonly value: string;
}

/** Legal-form suffixes that do not identify a company. */
const LEGAL_SUFFIXES = new Set([
  'srl',
  'srls',
  'spa',
  'sapa',
  'snc',
  'sas',
  'ss',
  'scarl',
  'scrl',
  'coop',
  'societa',
  'gmbh',
  'ag',
  'ltd',
  'llc',
  'inc',
  'sa',
  'sarl',
  'bv',
  'nv',
  'plc',
  'co',
]);

/** Domains that identify a mailbox provider, not a company. Never used as an alias. */
export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'outlook.it',
  'hotmail.com',
  'hotmail.it',
  'live.com',
  'live.it',
  'msn.com',
  'yahoo.com',
  'yahoo.it',
  'icloud.com',
  'me.com',
  'libero.it',
  'virgilio.it',
  'alice.it',
  'tin.it',
  'tim.it',
  'tiscali.it',
  'fastwebnet.it',
  'email.it',
  'inwind.it',
  'iol.it',
  'pec.it',
  'legalmail.it',
  'protonmail.com',
  'proton.me',
]);

/** Accents removed, lowercase, punctuation to spaces, legal suffixes dropped, single spaces. */
export function nameKey(name: string): string {
  const folded = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    // Dotted abbreviations become one token: "s.r.l." -> "srl", "s.p.a." -> "spa".
    .replace(/\b(?:[a-z]\.){2,}/g, (abbreviation) => abbreviation.replace(/\./g, ''))
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const tokens = folded.split(' ').filter((token) => token.length > 0);
  const kept = tokens.filter((token, index) => !(index > 0 && LEGAL_SUFFIXES.has(token)));
  return (kept.length > 0 ? kept : tokens).join(' ');
}

export function emailDomain(email: string): string | undefined {
  const at = email.lastIndexOf('@');
  if (at < 0) return undefined;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain.length > 0 ? domain : undefined;
}

export function isPublicEmailDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.has(domain.toLowerCase());
}

/** The canonical form stored and matched for each alias kind. */
export function normaliseAliasValue(kind: EntityAliasKind, raw: string): string {
  const value = raw.trim();
  switch (kind) {
    case 'name':
      return nameKey(value);
    case 'email':
      return value.toLowerCase();
    case 'email_domain':
      return value.toLowerCase().replace(/^@/, '');
    case 'vat':
      return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    case 'code':
      return value.toUpperCase().replace(/\s+/g, '');
  }
}
