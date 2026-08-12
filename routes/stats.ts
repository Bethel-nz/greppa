import { z } from "zod";
import { createRoute } from "@bethel-nz/sumi/router";
import { resolver } from "hono-openapi/zod";
import { getOrgStats } from "../lib/memory/service";
import { getMemoryCacheStats } from "../lib/memory/stats";

import { requestErrors } from '../lib/errors'
const statsSchema = z.object({
  orgId: z.string(),
  documents: z.object({
    total: z.number(),
    indexed: z.number(),
    pending: z.number(),
    failed: z.number(),
  }),
  memory: z.object({
    localFileSizeBytes: z.number(),
    localFileModifiedAt: z.string().nullable(),
    r2SnapshotCount: z.number(),
  }),
})

export default createRoute({
  get: {
    middleware: ["user-auth"],
    handler: async (c) => {
      const orgId = c.req.query('orgId')
      if (!orgId) {
        throw requestErrors.ORG_ID_REQUIRED()
      }

      const docStats = await getOrgStats(orgId)
      const cache = getMemoryCacheStats()

      return c.json({
        orgId,
        documents: {
          total: docStats.documents,
          indexed: docStats.events['memory.ingest.completed'] ?? 0,
          pending: docStats.events['memory.ingest.started'] ?? 0,
          failed: docStats.events['memory.ingest.failed'] ?? 0,
        },
        memory: {
          openScopes: cache.openScopes,
          cacheBytes: cache.cacheBytes,
          cacheBudgetBytes: cache.cacheBudgetBytes,
          overBudget: cache.overBudget,
        },
      });
    },
    openapi: {
      summary: "Organization memory stats",
      description: "Returns document counts and local scope-cache utilisation.",
      tags: ["stats"],
      responses: {
        200: {
          description: "Memory stats",
          content: { "application/json": { schema: resolver(statsSchema) } },
        },
        400: { description: 'orgId query param required' },
        401: { description: 'Authentication required' },
      },
    },
  },
});
