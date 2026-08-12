import { createRoute } from '@bethel-nz/sumi/router'
import { resolver } from 'hono-openapi/zod'
import { z } from 'zod'
import { getMemoryCacheStats } from '~/lib/memory/stats'
import { getDrizzle } from '~/lib/db'
import { eq, count, sql } from 'drizzle-orm'

const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  neon: z.object({ ok: z.boolean() }),
  r2: z.object({
    ok: z.boolean(),
    bucket: z.string(),
  }),
  memoryCache: z.object({
    ok: z.boolean(),
    openScopes: z.number(),
    cacheBytes: z.number(),
    cacheBudgetBytes: z.number().nullable(),
  }),
  worker: z.object({
    pendingJobs: z.number(),
    processingJobs: z.number(),
    failedJobsLast24h: z.number(),
  }),
})

export default createRoute({
  get: {
    handler: async (c) => {
      const neonOk = await checkNeon()
      const r2Ok = await checkR2()
      const cache = getMemoryCacheStats()
      const workerStats = await checkWorker()

      const status = neonOk && r2Ok.ok && !cache.overBudget ? 'ok' : 'degraded'

      return c.json({
        status,
        neon: { ok: neonOk },
        r2: r2Ok,
        memoryCache: {
          ok: !cache.overBudget,
          openScopes: cache.openScopes,
          cacheBytes: cache.cacheBytes,
          cacheBudgetBytes: cache.cacheBudgetBytes,
        },
        worker: workerStats,
      })
    },
    openapi: {
      summary: 'Internal: Memory health check',
      description: 'Checks Neon, R2, the local scope cache, and ingestion worker status.',
      tags: ['internal'],
      responses: {
        200: {
          description: 'Health status',
          content: { 'application/json': { schema: resolver(healthSchema) } },
        },
      },
    },
  },
})

async function checkNeon(): Promise<boolean> {
  try {
    const db = getDrizzle()
    await db.execute(sql`SELECT 1`)
    return true
  } catch {
    return false
  }
}

async function checkR2(): Promise<{ ok: boolean; bucket: string }> {
  const bucket = process.env.R2_BUCKET ?? 'greppa-memory'
  try {
    const { getStorage } = await import('~/lib/storage')
    await getStorage().list('scopes/')
    return { ok: true, bucket }
  } catch {
    return { ok: false, bucket }
  }
}

async function checkWorker(): Promise<{ pendingJobs: number; processingJobs: number; failedJobsLast24h: number }> {
  try {
    const db = getDrizzle()
    const schema = (await import('../../../db/schema/tenant')).ingestionJobs

    const [pending, processing, failed] = await Promise.all([
      db.select({ count: count() }).from(schema).where(eq(schema.status, 'pending')).then((r) => r[0]?.count ?? 0),
      db
        .select({ count: count() })
        .from(schema)
        .where(eq(schema.status, 'processing'))
        .then((r) => r[0]?.count ?? 0),
      db
        .select({ count: count() })
        .from(schema)
        .where(
          sql`${schema.status} = 'failed' AND ${schema.failedAt} > now() - interval '24 hours'`,
        )
        .then((r) => r[0]?.count ?? 0),
    ])

    return { pendingJobs: pending, processingJobs: processing, failedJobsLast24h: failed }
  } catch {
    return { pendingJobs: 0, processingJobs: 0, failedJobsLast24h: 0 }
  }
}
