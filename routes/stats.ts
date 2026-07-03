import { z } from "zod";
import { createRoute } from "@bethel-nz/sumi/router";
import { resolver } from "hono-openapi/zod";
import { getOrgStats } from "../lib/memory/service";
import { getMemvidLocalStats } from "../lib/memory/stats";
import { countR2Snapshots } from "../lib/memory/r2";

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
        return c.json({ error: 'orgId query param required' }, 400)
      }

      const [docStats, memvidStats, r2SnapshotCount] = await Promise.all([
        getOrgStats(orgId),
        getMemvidLocalStats(),
        countR2Snapshots('greppa/prod/').catch(() => 0),
      ])

      return c.json({
        orgId,
        documents: {
          total: docStats.documents,
          indexed: docStats.events['memory.ingest.completed'] ?? 0,
          pending: docStats.events['memory.ingest.started'] ?? 0,
          failed: docStats.events['memory.ingest.failed'] ?? 0,
        },
        memory: {
          localFileSizeBytes: memvidStats.sizeBytes,
          localFileModifiedAt: memvidStats.modifiedAt,
          r2SnapshotCount,
        },
      });
    },
    openapi: {
      summary: "Organization memory stats",
      description: "Returns document counts, Memvid local file size, and R2 snapshot count.",
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
