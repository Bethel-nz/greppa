import { z } from "zod";
import { createRoute } from "@bethel-nz/sumi/router";
import { resolver } from "hono-openapi/zod";
import { addMemory, getOrgDocumentTimeline, getOrgStats } from "../lib/memory/service";

const jsonBodySchema = z.object({
  title: z.string().min(1).describe("Title of the article or document"),
  content: z.string().min(1).describe("Full text content"),
  tags: z
    .array(z.string())
    .optional()
    .default([])
    .describe("Optional tags for retrieval"),
  orgId: z.string().min(1).describe("Organization ID"),
});

const articleSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  sourceType: z.string(),
  tags: z.array(z.string()),
  createdAt: z.string().datetime(),
});

const statsSchema = z.object({
  orgId: z.string(),
  documents: z.number(),
  events: z.record(z.string(), z.number()),
});

const listResponseSchema = z.object({
  orgId: z.string(),
  articles: z.array(articleSchema),
  total: z.number(),
  stats: statsSchema,
});

const ingestResponseSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  status: z.string(),
  message: z.string(),
});

export default createRoute({
  get: {
    middleware: ["user-auth", "rate-limit"],
    handler: async (c) => {
      const orgId = c.req.query('orgId')
      if (!orgId) {
        return c.json({ error: 'orgId query param required' }, 400)
      }

      const docs = await getOrgDocumentTimeline(orgId, 100)
      const stats = await getOrgStats(orgId)

      return c.json({
        orgId,
        articles: docs.map((d) => ({
          documentId: d.id,
          title: d.title,
          sourceType: d.sourceType,
          tags: (d.metadata as any)?.tags ?? [],
          createdAt: d.createdAt,
        })),
        total: docs.length,
        stats,
      });
    },
    openapi: {
      summary: "List all ingested articles",
      description: "Returns all documents for an organization with aggregated stats.",
      tags: ["knowledge"],
      responses: {
        200: {
          description: "List of articles with stats",
          content: { "application/json": { schema: resolver(listResponseSchema) } },
        },
        400: { description: 'orgId query param required' },
        401: { description: 'Authentication required' },
        429: { description: "Rate limit exceeded" },
      },
    },
  },

  // JSON path — plain text articles
  post: {
    schema: { json: jsonBodySchema },
    middleware: ["user-auth", "rate-limit"],
    handler: async (c) => {
      const { title, content, tags, orgId } = c.req.valid("json");
      const userId = c.get('userId')
      if (!userId) {
        return c.json({ error: 'authentication required' }, 401)
      }

      const result = await addMemory({
        userId,
        orgId,
        title,
        text: content,
        sourceType: 'document',
      });

      return c.json(
        { documentId: result.documentId, title, status: result.status, message: "Article stored" },
        201,
      );
    },
    openapi: {
      summary: "Ingest a text article",
      description: "Stores plain text in the org's knowledge base. For file uploads, use POST /knowledge/presign + POST /knowledge/ingest instead.",
      tags: ["knowledge"],
      responses: {
        201: {
          description: "Article stored",
          content: { "application/json": { schema: resolver(ingestResponseSchema) } },
        },
        400: { description: "Invalid request body" },
        401: { description: 'Authentication required' },
        429: { description: "Rate limit exceeded" },
      },
    },
  },
});
