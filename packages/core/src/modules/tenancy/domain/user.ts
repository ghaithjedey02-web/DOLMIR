import { z } from 'zod';

import { UserIdSchema } from '../../../kernel/ids.js';

/**
 * A global identity. Authentication is delegated to the identity provider;
 * DOLMIR stores the provider's stable subject and the profile it needs.
 */
export const UserSchema = z
  .object({
    id: UserIdSchema,
    authSubject: z.string().trim().min(1).max(255),
    email: z.email().nullable(),
    displayName: z.string().trim().min(1).max(200).nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();
export type User = z.infer<typeof UserSchema>;

export const NewUserSchema = z
  .object({
    authSubject: z.string().trim().min(1).max(255),
    email: z.email().nullable().default(null),
    displayName: z.string().trim().min(1).max(200).nullable().default(null),
  })
  .strict();
export type NewUser = z.infer<typeof NewUserSchema>;
export type NewUserInput = z.input<typeof NewUserSchema>;
