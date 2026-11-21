import { createHash } from 'node:crypto';
import type { z } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const issue of r.error.issues) {
      const k = issue.path.join('.') || '_';
      if (!fields[k]) fields[k] = issue.message;
    }
    throw new HttpError(400, 'VALIDATION', 'Données invalides', { fields });
  }
  return r.data;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface User {
  id: string;
  org_id: string;
  name: string;
  role: 'AGENT' | 'VET' | 'FARMER';
}
