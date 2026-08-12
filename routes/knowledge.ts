import { z } from "zod";
import { createRoute } from "@bethel-nz/sumi/router";
import { resolver } from "hono-openapi/zod";
import { addMemory, getOrgStats, pageOrgDocuments } from "../lib/memory/service";
import { addScopedMemory } from "../lib/memory/scoped-service";
import { scopedDocumentId } from "../lib/memory/document-id";
import { resolveIngestionStrategy } from "../lib/knowledge/ingestion/ingestion-router";
import { parseText } from "../lib/knowledge/parsers/text.parser";
import { parseHtml } from "../lib/knowledge/parsers/html.parser";
import { parseAnyDoc } from "../lib/knowledge/parsers/anydoc.parser";
import { formatBytes, INLINE_UPLOAD_LIMIT_BYTES } from "../lib/memory/upload-limits";
import { authErrors, knowledgeErrors, requestErrors } from "../lib/errors";

export { INLINE_UPLOAD_LIMIT_BYTES };

async function extractText(
  buffer: Buffer,
  contentType: string,
  fileName: string,
): Promise<{ text: string; title?: string }> {
  const strategy = resolveIngestionStrategy(contentType, fileName);
  const input = { buffer, contentType, fileName };
  if (strategy === "custom-text") return parseAnyDocSafe(() => parseText(input));
  if (strategy === "custom-html") return parseAnyDocSafe(() => parseHtml(input));
  if (strategy === "anydoc") return parseAnyDocSafe(() => parseAnyDoc(input));
  throw new Error(`unsupported file type: ${contentType || fileName}`);
}

async function parseAnyDocSafe(
  run: () => Promise<{ text: string; title?: string }>,
): Promise<{ text: string; title?: string }> {
  const parsed = await run();
  if (!parsed.text?.trim()) throw new Error("no readable text found in file");
  return parsed;
}

const jsonBodySchema = z.object({
  title: z.string().min(1).describe("Title of the article or document"),
  content: z.string().min(1).describe("Full text content"),
  tags: z
    .array(z.string())
    .optional()
    .default([])
    .describe("Optional tags for retrieval"),
  orgId: z.string().min(1).optional().describe("Organization ID; omit to store as personal memory"),
  workspaceId: z.string().min(1).optional().describe("Workspace ID. Stored records are searchable anywhere inside this workspace."),
  folderId: z.string().min(1).optional().describe("Optional folder that organises this record inside its workspace."),
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
  nextCursor: z.string().nullable().describe('Pass as ?cursor= to fetch the next page, or null at the end.'),
  stats: statsSchema,
});

const listQuerySchema = z.object({
  orgId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional().describe('The nextCursor from a previous page.'),
});

const ingestResponseSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  status: z.string(),
  message: z.string(),
});

export default createRoute({
  get: {
    schema: { query: listQuerySchema },
    middleware: ["user-auth", "rate-limit"],
    handler: async (c) => {
      const { orgId, limit, cursor } = c.req.valid('query')
      if (!orgId) throw requestErrors.ORG_ID_REQUIRED()

      const { items: docs, nextCursor } = await pageOrgDocuments(orgId, { limit, cursor })
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
        nextCursor,
        stats,
      });
    },
    openapi: {
      summary: "List ingested articles",
      description: "Returns a page of documents for an organization with aggregated stats. Follow nextCursor to page.",
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

  put: {
    middleware: ["user-auth", "rate-limit"],
    handler: async (c) => {
      const userId = c.get('userId')
      if (!userId) throw authErrors.REQUIRED()

      let form: FormData
      try {
        form = await c.req.formData()
      } catch {
        throw requestErrors.NOT_MULTIPART()
      }

      const file = form.get('file')
      if (!(file instanceof File)) throw requestErrors.FIELD_REQUIRED({ field: 'file field' })

      if (file.size > INLINE_UPLOAD_LIMIT_BYTES) {
        throw knowledgeErrors.TOO_LARGE({
          limit: `${formatBytes(INLINE_UPLOAD_LIMIT_BYTES)} inline`,
          fix: 'Use POST /knowledge/presign for files above the inline limit.',
        })
      }

      const buffer = Buffer.from(await file.arrayBuffer())
      let parsed: { text: string; title?: string }
      try {
        parsed = await extractText(buffer, file.type, file.name)
      } catch (err) {
        throw knowledgeErrors.UNPARSEABLE({ reason: (err as Error).message, cause: err as Error })
      }

      const title = (form.get('title') as string | null)?.trim() || parsed.title || file.name
      const workspaceId = form.get('workspaceId')?.toString() || undefined
      const folderId = form.get('folderId')?.toString() || undefined

      const result = await addScopedMemory({
        id: scopedDocumentId(userId, workspaceId, parsed.text),
        userId,
        title,
        text: parsed.text,
        sourceType: 'document',
        sourceUrl: file.name,
        workspaceId,
        folderId,
      })

      const duplicate = result.status === 'duplicate'
      const wordCount = parsed.text.split(/\s+/).filter(Boolean).length

      return c.json(
        {
          documentId: result.documentId,
          title,
          status: result.status,
          wordCount,
          message: duplicate
            ? 'Already in your memory; this file matches one you uploaded before'
            : 'File stored in your memory',
        },
        duplicate ? 200 : 201,
      )
    },
    openapi: {
      summary: 'Upload a file as memory',
      description:
        "Parses a file inline and stores it in the caller's personal memory, where the chat agent can retrieve it. Re-uploading a file whose text matches one already stored returns the existing document instead of a duplicate. Files over 2 MiB should use POST /knowledge/presign instead.",
      tags: ['knowledge'],
      responses: {
        200: { description: 'File already stored; existing document returned' },
        201: { description: 'File stored' },
        400: { description: 'Missing or malformed multipart body' },
        401: { description: 'Authentication required' },
        413: { description: 'File too large for inline upload' },
        415: { description: 'Unsupported file type or no readable text' },
      },
    },
  },

  post: {
    schema: { json: jsonBodySchema },
    middleware: ["user-auth", "rate-limit"],
    handler: async (c) => {
      const { title, content, tags, orgId, workspaceId, folderId } = c.req.valid("json");
      const userId = c.get('userId')
      if (!userId) throw authErrors.REQUIRED()
      if (orgId && workspaceId) throw requestErrors.SCOPE_AMBIGUOUS()

      const result = orgId
        ? await addMemory({ userId, orgId, title, text: content, sourceType: 'document', tags, folderId })
        : await addScopedMemory({
            id: scopedDocumentId(userId, workspaceId, title, content),
            userId,
            title,
            text: content,
            sourceType: 'document',
            workspaceId,
            folderId,
          });

      return c.json(
        {
          documentId: result.documentId,
          title,
          status: result.status,
          message: result.status === 'duplicate' ? 'Article already stored' : 'Article stored',
        },
        result.status === 'duplicate' ? 200 : 201,
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
