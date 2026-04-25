import { z } from "zod";
import { createRoute } from "@bethel-nz/sumi/router";
import { resolver } from "hono-openapi/zod";
import { getReader } from "../lib/memory";

const responseSchema = z.object({
  articles: z.number().describe("Number of active articles"),
  sizeMb: z.number().describe("Current file size in MB"),
  capacityMb: z.number().describe("Total capacity in MB"),
  utilizationPercent: z.number().describe("Storage utilization percentage"),
});

export default createRoute({
  get: {
    middleware: ["session-auth"],
    handler: async (c) => {
      const { loadGreppaConfig } = await import('../lib/config')
      const cfg = loadGreppaConfig()
      if (!cfg.allowPublicStats && !c.get('isDeployer')) {
        return c.json({ error: 'deployer key required' }, 403)
      }
      const mem = await getReader();
      const s = await mem.stats();
      return c.json({
        articles: s.active_frame_count,
        sizeMb: Math.round((s.size_bytes / 1024 / 1024) * 100) / 100,
        capacityMb: Math.round((s.capacity_bytes / 1024 / 1024) * 100) / 100,
        utilizationPercent: s.storage_utilisation_percent,
      });
    },
    openapi: {
      summary: "Knowledge base stats",
      tags: ["stats"],
      responses: {
        200: {
          description: "Storage stats",
          content: { "application/json": { schema: resolver(responseSchema) } },
        },
      },
    },
  },
});
