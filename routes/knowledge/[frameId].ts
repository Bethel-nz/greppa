import { z } from "zod";
import { createRoute } from "@bethel-nz/sumi/router";
import { getWriter, getReader } from "../../lib/memory";

const paramSchema = z.object({ frameId: z.string() });

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
});

export default createRoute({
  get: {
    schema: { param: paramSchema },
    middleware: ["session-auth", "rate-limit"],
    handler: async (c) => {
      const { frameId } = c.req.valid("param");
      const mem = await getReader();
      const info = await mem.getFrameInfo(Number(frameId));
      if (!info) return c.json({ error: "Not found" }, 404);
      return c.json({
        frameId,
        title: info.title,
        tags: info.tags ?? [],
        createdAt: new Date((info.timestamp as number) * 1000).toISOString(),
      });
    },
    openapi: {
      summary: "Get article metadata",
      tags: ["knowledge"],
      responses: {
        200: { description: "Article metadata" },
        404: { description: "Not found" },
      },
    },
  },

  patch: {
    schema: { param: paramSchema, json: updateSchema },
    middleware: ["session-auth", "rate-limit"],
    handler: async (c) => {
      const { frameId } = c.req.valid("param");
      const updates = c.req.valid("json");

      const mem = await getWriter();
      const existing = await mem.getFrameInfo(Number(frameId));
      if (!existing) return c.json({ error: "Not found" }, 404);

      await mem.remove(frameId);
      const newFrameId = await mem.put({
        title: updates.title ?? existing.title,
        label: "knowledge",
        text: updates.content,
        tags: updates.tags ?? existing.tags ?? [],
      });
      await mem.seal();

      return c.json({ frameId: String(newFrameId), message: "Article updated" });
    },
    openapi: {
      summary: "Update an article",
      description: "Replaces the article content. All fields are optional — omit to keep existing value.",
      tags: ["knowledge"],
      responses: {
        200: { description: "Updated" },
        404: { description: "Not found" },
        429: { description: "Rate limit exceeded" },
      },
    },
  },

  delete: {
    schema: { param: paramSchema },
    middleware: ["session-auth", "rate-limit"],
    handler: async (c) => {
      const { loadGreppaConfig } = await import('../../lib/config')
      const cfg = loadGreppaConfig()
      if (!cfg.allowPublicDelete && !c.get('isDeployer')) {
        return c.json({ error: 'deployer key required' }, 403)
      }
      const { frameId } = c.req.valid("param");
      const mem = await getWriter();
      const existing = await mem.getFrameInfo(Number(frameId));
      if (!existing) return c.json({ error: "Not found" }, 404);
      await mem.remove(frameId);
      await mem.seal();
      return c.json({ message: "Article deleted" });
    },
    openapi: {
      summary: "Delete an article",
      tags: ["knowledge"],
      responses: {
        200: { description: "Deleted" },
        404: { description: "Not found" },
      },
    },
  },
});
