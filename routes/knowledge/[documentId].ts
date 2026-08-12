import { z } from "zod";
import { createRoute } from "@bethel-nz/sumi/router";
import { resolver } from "hono-openapi/zod";
import { getDocumentById, updateDocument, softDeleteDocument } from "../../lib/knowledge/services/knowledge.service";

import { knowledgeErrors, requestErrors } from '../../lib/errors'
const paramSchema = z.object({ documentId: z.string() });

const articleSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  sourceType: z.string(),
  sourceUrl: z.string().nullable(),
  status: z.string(),
  contentType: z.string().nullable(),
  fileName: z.string().nullable(),
  createdAt: z.string().datetime(),
})

const patchSchema = z.object({
  title: z.string().min(1).optional(),
  sourceUrl: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export default createRoute({
  get: {
    schema: { param: paramSchema },
    middleware: ["user-auth", "rate-limit"],
    handler: async (c) => {
      const { documentId } = c.req.valid("param");
      const orgId = c.req.query('orgId')
      if (!orgId) {
        throw requestErrors.ORG_ID_REQUIRED()
      }

      const doc = await getDocumentById(documentId, orgId)
      if (!doc || doc.status === 'deleted') {
        throw knowledgeErrors.NOT_FOUND()
      }

      return c.json({
        documentId: doc.id,
        title: doc.title,
        sourceType: doc.sourceType,
        sourceUrl: doc.sourceUrl,
        status: doc.status,
        contentType: doc.contentType,
        fileName: doc.fileName,
        createdAt: doc.createdAt,
      });
    },
    openapi: {
      summary: "Get article metadata",
      description: "Returns metadata for a specific document by ID.",
      tags: ["knowledge"],
      responses: {
        200: {
          description: "Article metadata",
          content: { "application/json": { schema: resolver(articleSchema) } },
        },
        400: { description: 'orgId query param required' },
        401: { description: 'Authentication required' },
        404: { description: "Not found" },
        429: { description: "Rate limit exceeded" },
      },
    },
  },

  patch: {
    schema: { param: paramSchema, json: patchSchema },
    middleware: ["user-auth", "rate-limit"],
    handler: async (c) => {
      const { documentId } = c.req.valid("param");
      const orgId = c.req.query('orgId')
      if (!orgId) {
        throw requestErrors.ORG_ID_REQUIRED()
      }

      const patch = c.req.valid("json");
      const updated = await updateDocument(documentId, orgId, patch);

      if (!updated) {
        throw knowledgeErrors.NOT_FOUND()
      }

      return c.json({
        documentId: updated.id,
        title: updated.title,
        status: updated.status,
        message: "Article updated",
      });
    },
    openapi: {
      summary: "Update an article",
      description: "Updates document metadata (title, sourceUrl, metadata). Does not mutate Memvid frames in V1.",
      tags: ["knowledge"],
      responses: {
        200: { description: "Updated" },
        400: { description: 'orgId query param required' },
        401: { description: 'Authentication required' },
        404: { description: "Not found" },
        429: { description: "Rate limit exceeded" },
      },
    },
  },

  delete: {
    schema: { param: paramSchema },
    middleware: ["user-auth", "rate-limit"],
    handler: async (c) => {
      const { documentId } = c.req.valid("param");
      const orgId = c.req.query('orgId')
      if (!orgId) {
        throw requestErrors.ORG_ID_REQUIRED()
      }

      const deleted = await softDeleteDocument(documentId, orgId);
      if (!deleted) {
        throw knowledgeErrors.NOT_FOUND()
      }

      return c.json({ message: "Article deleted" });
    },
    openapi: {
      summary: "Delete an article",
      description: "Soft-deletes a document from the org's knowledge base.",
      tags: ["knowledge"],
      responses: {
        200: { description: "Deleted" },
        400: { description: 'orgId query param required' },
        401: { description: 'Authentication required' },
        404: { description: "Not found" },
        429: { description: "Rate limit exceeded" },
      },
    },
  },
});
