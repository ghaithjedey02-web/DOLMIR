import { z } from 'zod';

/**
 * Action-policy vocabulary (ADR-0011), shared by the AI layer that enforces it
 * and the workspace module that stores company overrides.
 *
 *   read     returns data
 *   analyze  computes or classifies over data it was given
 *   draft    produces content a human may later send or apply; nothing outside DOLMIR changes
 *   act      changes the world or an approved record
 */
export const ToolEffect = {
  READ: 'read',
  ANALYZE: 'analyze',
  DRAFT: 'draft',
  ACT: 'act',
} as const;
export const ToolEffectSchema = z.enum(['read', 'analyze', 'draft', 'act']);
export type ToolEffect = z.infer<typeof ToolEffectSchema>;

export const PolicyLevel = {
  READ_ONLY: 'READ_ONLY',
  SUGGEST: 'SUGGEST',
  DRAFT: 'DRAFT',
  REQUIRE_APPROVAL: 'REQUIRE_APPROVAL',
  AUTO_EXECUTE: 'AUTO_EXECUTE',
} as const;
export const PolicyLevelSchema = z.enum([
  'READ_ONLY',
  'SUGGEST',
  'DRAFT',
  'REQUIRE_APPROVAL',
  'AUTO_EXECUTE',
]);
export type PolicyLevel = z.infer<typeof PolicyLevelSchema>;
