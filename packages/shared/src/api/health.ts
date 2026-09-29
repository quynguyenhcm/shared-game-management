import { z } from 'zod';

/** Response body of `GET /health` (API) — shared so the web client validates the same shape. */
export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  db: z.enum(['ok', 'unreachable']),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof HealthResponse>;
