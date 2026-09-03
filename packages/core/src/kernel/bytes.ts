import { z } from 'zod';

/**
 * Raw bytes at a validation boundary. `z.instanceof` would narrow to
 * `Uint8Array<ArrayBuffer>`, which rejects the perfectly ordinary
 * `Uint8Array<ArrayBufferLike>` that comes back from Node's buffers and from
 * every adapter; one shared schema keeps every boundary talking about the same
 * type.
 */
export const BytesSchema = z.custom<Uint8Array>((value) => value instanceof Uint8Array, {
  message: 'must be a Uint8Array',
});
