import { z } from 'zod';

/**
 * Where a fact or an artefact came from. Shared by the ledger's provenance and
 * by ingested documents, so every module names sources the same way.
 */
export const SourceKind = {
  DOCUMENT: 'DOCUMENT',
  EMAIL: 'EMAIL',
  ERP: 'ERP',
  USER: 'USER',
  SYSTEM: 'SYSTEM',
  AI: 'AI',
  INTEGRATION: 'INTEGRATION',
} as const;
export const SourceKindSchema = z.enum([
  'DOCUMENT',
  'EMAIL',
  'ERP',
  'USER',
  'SYSTEM',
  'AI',
  'INTEGRATION',
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;
