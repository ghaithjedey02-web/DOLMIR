import { z } from 'zod';

/**
 * Who has been authenticated. DOLMIR does not run its own credential store:
 * an identity provider (Supabase Auth in production, the dev issuer locally)
 * signs a JWT, and the verified claims become a `Principal`. Only the claims
 * the platform needs are kept; arbitrary token payload never travels further.
 */
export const UserPrincipalSchema = z
  .object({
    kind: z.literal('user'),
    /** The provider's stable subject — the key of `users.auth_subject`. */
    subject: z.string().trim().min(1).max(255),
    issuer: z.string().trim().min(1),
    email: z.email().optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    expiresAt: z.date(),
  })
  .strict();
export type UserPrincipal = z.infer<typeof UserPrincipalSchema>;

export type Principal = UserPrincipal;
