import type { SumiContext } from '@bethel-nz/sumi/types';
import { createMiddleware } from '@bethel-nz/sumi/router';

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 30;

const store = new Map<string, { count: number; start: number }>();

export default createMiddleware({
  _: async (c: SumiContext, next) => {
    const key = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown';
    const now = Date.now();
    const entry = store.get(key);

    if (!entry || now - entry.start > WINDOW_MS) {
      store.set(key, { count: 1, start: now });
    } else if (entry.count >= MAX_REQUESTS) {
      const retryAfter = Math.ceil((WINDOW_MS - (now - entry.start)) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: 'Rate limit exceeded', retryAfterSeconds: retryAfter }, 429);
    } else {
      entry.count++;
    }

    await next();
  },
});
