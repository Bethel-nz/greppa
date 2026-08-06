import { tool } from 'ai'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { redis } from '~/lib/redis'
import type { makeEmitter } from '~/lib/emit'
import { scanRetrievedSnippet } from '~/lib/security'
import {
  addScopedMemory,
  askScopedMemory,
  listScopedMemoryEdges,
} from '~/lib/memory/scoped-service'

export type ChatSource = { title: string; snippet: string; score: number }

/**
 * The chat agent's tools. Both are gated on an authenticated userId. Tool side
 * effects emit progress cues directly (rather than parsing the model stream),
 * and `remember` is idempotent so an Upstash Workflow replay cannot double-write
 * the same fact.
 */
export function buildTools(opts: {
  userId: string
  emit: ReturnType<typeof makeEmitter>
  onSources: (sources: ChatSource[]) => void
  /** The folder/workspace this conversation belongs to, if any. */
  workspaceId?: string
}) {
  const search = async (query: string, folderId?: string) => {
    await opts.emit('cue', { status: 'searching_knowledge', at: Date.now(), query })
    const result = await askScopedMemory({
      userId: opts.userId,
      question: query,
      limit: 5,
      folderId,
    })
    const sources: ChatSource[] = (result.sources ?? []).map((source) => ({
      title: source.title,
      snippet: source.snippet,
      score: source.score,
    }))
    opts.onSources(sources)
    await opts.emit('cue', { status: 'reading_sources', at: Date.now(), count: sources.length })
    await opts.emit('sources', sources)
    return scanRetrievedSnippet(result.context ?? 'No relevant information found.')
  }

  const tools = {
    search_knowledge: tool({
      description: "Search the user's stored knowledge and long-term memory for relevant context.",
      inputSchema: z.object({
        query: z.string().describe('A precise search query targeting the information needed.'),
      }),
      execute: ({ query }) => search(query),
    }),
    remember: tool({
      description:
        "Store an important, durable fact from the conversation into the user's long-term memory for future recall. Use only for information worth remembering across sessions, not casual chatter. Add relationships only when they make a useful fact explicit.",
      inputSchema: z.object({
        title: z.string().describe('A short title for the fact.'),
        text: z.string().describe('The fact to remember, stated clearly and self-contained.'),
        edges: z
          .array(
            z.object({
              source: z.string().min(1).describe('The entity the relationship starts from.'),
              target: z.string().min(1).describe('The entity the relationship points to.'),
              relation: z.string().min(1).describe('A compact verb or relationship, such as "works on" or "prefers".'),
              weight: z.number().positive().optional().describe('Optional confidence or strength. Defaults to 1.'),
            }),
          )
          .max(20)
          .optional()
          .default([])
          .describe('Optional relationships stated by this memory.'),
      }),
      execute: async ({ title, text, edges }) => {
        // Idempotency: the agent loop runs outside workflow.run, so a replay would
        // re-execute this tool. Dedupe on a content hash so the write happens once.
        const hash = createHash('sha256').update(JSON.stringify({ title, text, edges, workspaceId: opts.workspaceId })).digest('hex')
        const fresh = await redis.set(`mem:written:${opts.userId}:${hash}`, '1', { nx: true, ex: 3600 })
        if (fresh !== 'OK') return 'Already saved (duplicate).'
        await addScopedMemory({
          userId: opts.userId,
          title,
          text,
          sourceType: 'chat',
          folderId: opts.workspaceId,
          edges,
        })
        return edges.length ? `Saved to your memory with ${edges.length} relationship(s).` : 'Saved to your memory.'
      },
    }),
    list_edges: tool({
      description:
        "List relationships already stored in the user's memory. Use this when the question is about how people, projects, decisions, or facts relate to one another rather than asking for a specific document.",
      inputSchema: z.object({
        entity: z.string().min(1).optional().describe('Optional entity name to focus the graph around.'),
        relation: z.string().min(1).optional().describe('Optional relationship type to filter by.'),
      }),
      execute: async ({ entity, relation }) => {
        const edges = await listScopedMemoryEdges({
          userId: opts.userId,
          entity,
          relation,
          folderId: opts.workspaceId,
          limit: 30,
        })
        if (edges.length === 0) return 'No matching relationships are stored yet.'
        return edges.map((edge) => `${edge.source} ${edge.relation} ${edge.target} (${edge.documentTitle})`).join('\n')
      },
    }),
  }

  if (!opts.workspaceId) return tools

  return {
    ...tools,
    search_workspace: tool({
      description:
        'Search only the current workspace. Use this when the user asks about another conversation, file, or decision in this workspace. It does not search their entire personal memory.',
      inputSchema: z.object({
        query: z.string().describe('A precise query for the other workspace conversations or files.'),
      }),
      execute: ({ query }) => search(query, opts.workspaceId),
    }),
  }
}
