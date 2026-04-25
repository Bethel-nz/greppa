import { z } from "zod";
import { createRoute } from "@bethel-nz/sumi/router";
import { resolver } from "hono-openapi/zod";
import { getWriter, getReader } from "../lib/memory";
import { tmpdir } from "os";
import { join } from "path";
import { unlink } from "fs/promises";

const jsonBodySchema = z.object({
  title: z.string().min(1).describe("Title of the article or document"),
  content: z.string().min(1).describe("Full text content"),
  tags: z
    .array(z.string())
    .optional()
    .default([])
    .describe("Optional tags for retrieval"),
});

const responseSchema = z.object({
  frameId: z.string(),
  title: z.string(),
  wordCount: z.number().nullable(),
  message: z.string(),
});

export default createRoute({
  get: {
    middleware: ["session-auth", "rate-limit"],
    handler: async (c) => {
      const mem = await getReader();
      const tl = await mem.timeline({ limit: 100 });
      const entries = await Promise.all(
        Object.values(tl).map(async (e: any) => {
          const info = await mem.getFrameInfo(e.frame_id);
          return {
            frameId: String(e.frame_id),
            title: info.title,
            preview: e.preview,
            tags: info.tags ?? [],
            createdAt: new Date(e.timestamp * 1000).toISOString(),
          };
        }),
      );
      return c.json({ articles: entries, total: entries.length });
    },
    openapi: {
      summary: "List all ingested articles",
      tags: ["knowledge"],
      responses: {
        200: { description: "List of articles" },
      },
    },
  },

  // JSON path — plain text articles
  post: {
    schema: { json: jsonBodySchema },
    middleware: ["session-auth", "rate-limit"],
    handler: async (c) => {
      const { title, content, tags } = c.req.valid("json");
      const wordCount = content.trim().split(/\s+/).filter(Boolean).length;
      const mem = await getWriter();
      const frameId = await mem.put({
        title,
        label: "knowledge",
        text: content,
        tags,
      });
      await mem.seal();
      return c.json(
        { frameId, title, wordCount, message: "Article stored" },
        201,
      );
    },
    openapi: {
      summary: "Ingest a text article",
      description: "Store plain text. Available as context in /chat.",
      tags: ["knowledge"],
      responses: {
        201: {
          description: "Stored",
          content: { "application/json": { schema: resolver(responseSchema) } },
        },
        429: { description: "Rate limit exceeded" },
      },
    },
  },

  // File upload path — PDF, DOCX, etc.
  put: {
    middleware: ["session-auth", "rate-limit"],
    handler: async (c) => {
      const body = await c.req.parseBody();
      const file = body["file"];
      const title = body["title"];

      if (!(file instanceof File))
        return c.json({ error: "Missing file field" }, 400);
      if (typeof title !== "string" || !title.trim())
        return c.json({ error: "Missing title field" }, 400);

      const tags =
        typeof body["tags"] === "string"
          ? body["tags"]
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean)
          : [];

      const ext = file.name.split(".").pop() ?? "bin";
      const tmpPath = join(tmpdir(), `greppa-${Date.now()}.${ext}`);
      await Bun.write(tmpPath, file);

      try {
        const mem = await getWriter();
        const frameId = await mem.put({
          title,
          label: "knowledge",
          file: tmpPath,
          tags,
        });
        await mem.seal();
        return c.json(
          { frameId, title, wordCount: null, message: "File stored" },
          201,
        );
      } finally {
        unlink(tmpPath).catch(() => {});
      }
    },
    openapi: {
      summary: "Ingest a document file",
      description:
        "Upload a PDF, DOCX, or other supported file as multipart/form-data. Fields: file (required), title (required), tags (optional, comma-separated).",
      tags: ["knowledge"],
      responses: {
        201: {
          description: "Stored",
          content: { "application/json": { schema: resolver(responseSchema) } },
        },
        400: { description: "Missing file or title" },
        429: { description: "Rate limit exceeded" },
      },
    },
  },
});
