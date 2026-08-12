import { tool } from 'ai'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { redis } from '~/lib/redis'
import type { makeEmitter } from '~/lib/emit'
import { scanRetrievedSnippet } from '~/lib/security'
import {
  addScopedMemory,
  retrieveScopedContext,
  listScopedMemoryEdges,
  resolveScopedEntities,
} from '~/lib/memory/scoped-service'

export type ChatSource = {
  title: string
  snippet: string
  score: number
  documentId?: string
  sourceType?: string
  sourceUrl?: string | null
}

const quoted = (labels: string[]) => labels.map((label) => `"${label}"`).join(', ')

async function attempt(tool: string, run: () => Promise<string>): Promise<string> {
  try {
    return await run()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(`[chat] ${tool} failed`, err)
    return `${tool} failed: ${reason}. Do not retry the identical call. Either change the arguments or tell the user this lookup is unavailable right now.`
  }
}

export function buildTools(opts: {
  userId: string
  emit: ReturnType<typeof makeEmitter>
  onSources: (sources: ChatSource[]) => void
  workspaceId?: string
  folderId?: string
  orgId?: string
}) {
  const search = async (
    query: string,
    scope: { workspaceId?: string; folderId?: string; includeOrg?: boolean } = {},
  ) => {
    await opts.emit('cue', { status: 'searching_knowledge', at: Date.now(), query })
    const result = await retrieveScopedContext({
      userId: opts.userId,
      question: query,
      limit: 5,
      workspaceId: scope.workspaceId,
      folderId: scope.folderId,
      orgId: scope.includeOrg ? opts.orgId : undefined,
    })
    const sources: ChatSource[] = (result.sources ?? []).map((source) => ({
      title: source.title,
      snippet: source.snippet,
      score: source.score,
      ...(source.documentId ? { documentId: source.documentId } : {}),
      ...(source.sourceType ? { sourceType: source.sourceType } : {}),
      ...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}),
    }))
    opts.onSources(sources)
    await opts.emit('cue', { status: 'reading_sources', at: Date.now(), count: sources.length })
    await opts.emit('sources', sources)

    if (sources.length === 0) {
      const { suggested } = await resolveScopedEntities({ userId: opts.userId, text: query })
      return suggested.length
        ? `Nothing stored matched that query. These entity names are stored and resemble it: ${quoted(suggested)}. Search once more naming one of them exactly as written.`
        : 'Nothing stored matched that query, and no stored entity resembles it. Tell the user nothing is saved on this rather than searching again with reworded terms.'
    }

    return scanRetrievedSnippet(result.context ?? 'No relevant information found.')
  }

  const tools = {
    search_knowledge: tool({
      description: `${
        opts.folderId
          ? 'Search the current folder: the conversations and files filed in it.'
          : opts.workspaceId
            ? 'Search the current workspace, including conversations and files placed in any folder inside it.'
            : "Search the user's stored knowledge and long-term memory, including files they have uploaded."
      } Returns document passages, and searches wording, meaning, and the stored relationship graph in a single pass.

Use it whenever the answer might depend on something saved earlier, and cite what comes back.
Do not use it to enumerate how entities relate to one another; that is list_edges.
Name every entity in the query exactly as it is written in memory, kept whole. Names are what the graph matches on, so "Helios cutover" reaches linked memories where "the cutover project" does not.
If it reports that nothing matched but names close entities, search once more using one of those names. If it reports nothing resembles the query, stop and say so instead of rewording.`,
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            'A precise search query targeting the information needed. Spell out any entity involved by its real name, whole and unparaphrased, so linked memories are reachable.',
          ),
      }),
      execute: ({ query }) =>
        attempt('search_knowledge', () =>
          search(
            query,
            opts.workspaceId
              ? { workspaceId: opts.workspaceId, folderId: opts.folderId }
              : { includeOrg: true },
          ),
        ),
    }),
    remember: tool({
      description: `Store a durable fact from the conversation in the user's long-term memory.

Use it for information worth recalling in a later session: decisions, preferences, ownership, commitments, corrections to something already stored.
Do not use it for casual chatter, for anything already retrieved from memory, or to record your own reasoning.
Whenever the fact links two named things, record the edge. A fact saved without edges is only ever found by its wording; one saved with edges is reachable from either name.`,
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
          .describe(
            'Relationships this memory states. A fact recorded with edges is retrievable later from either entity, so add an edge whenever the fact links two named things.',
          ),
      }),
      execute: ({ title, text, edges }) =>
        attempt('remember', async () => {
          const hash = createHash('sha256').update(JSON.stringify({ title, text, edges, workspaceId: opts.workspaceId, folderId: opts.folderId })).digest('hex')
          const fresh = await redis.set(`mem:written:${opts.userId}:${hash}`, '1', { nx: true, ex: 3600 })
          if (fresh !== 'OK') return 'Already saved (duplicate). Do not save it again.'
          await addScopedMemory({
            userId: opts.userId,
            title,
            text,
            sourceType: 'fact',
            workspaceId: opts.workspaceId,
            folderId: opts.folderId,
            edges,
          })
          return edges.length
            ? `Saved with ${edges.length} relationship(s), reachable later from ${quoted(edges.flatMap((edge) => [edge.source, edge.target]))}.`
            : 'Saved. It carries no relationships, so it will only be found by its wording.'
        }),
    }),
    list_edges: tool({
      description: `${
        opts.workspaceId
          ? 'List relationships stored across the whole current workspace, in every folder.'
          : "List relationships already stored in the user's memory."
      } Returns relationships, never document text.

Use it when the relationships are the answer: who owns or decided something, how two entities connect, what is recorded about one name.
Use it before search_knowledge when a question turns on a named entity and you do not yet know what surrounds it, then search naming the entities it returns.
Do not use it to read what a document says; that is search_knowledge.
The entity argument matches stored names exactly. If it reports the name is unknown, retry with one of the close names it lists rather than a rephrasing.`,
      inputSchema: z.object({
        entity: z.string().min(1).optional().describe('Optional entity name to focus the graph around.'),
        relation: z.string().min(1).optional().describe('Optional relationship type to filter by.'),
      }),
      execute: ({ entity, relation }) =>
        attempt('list_edges', async () => {
          const edges = await listScopedMemoryEdges({
            userId: opts.userId,
            entity,
            relation,
            workspaceId: opts.workspaceId,
            limit: 30,
          })
          if (edges.length > 0) {
            return edges
              .map((edge) => `${edge.source} ${edge.relation} ${edge.target} (${edge.documentTitle})`)
              .join('\n')
          }

          if (!entity) {
            return relation
              ? `No relationship of type "${relation}" is stored. Call list_edges with no filters to see what relationships exist.`
              : 'No relationships are stored yet. Use search_knowledge for document contents.'
          }

          const { matched, suggested } = await resolveScopedEntities({
            userId: opts.userId,
            text: entity,
          })
          if (matched.length === 0) {
            return suggested.length
              ? `"${entity}" is not a stored entity. Stored names close to it: ${quoted(suggested)}. Call list_edges again with one of them exactly as written.`
              : `"${entity}" is not a stored entity and nothing stored resembles it. Use search_knowledge, or tell the user nothing is recorded about it.`
          }
          return relation
            ? `${quoted(matched)} is stored but has no "${relation}" relationship. Call list_edges with the entity alone to see every relationship it does have.`
            : `${quoted(matched)} is stored as an entity but carries no relationships. Use search_knowledge to read what the memories about it say.`
        }),
    }),
  }

  if (!opts.workspaceId || !opts.folderId) return tools

  return {
    ...tools,
    search_workspace: tool({
      description:
        'Search the whole workspace, past the current folder: every conversation and file placed in any folder inside it. Use this when the user asks about another conversation, file, or decision outside the folder they are in.',
      inputSchema: z.object({
        query: z.string().describe('A precise query for the other workspace conversations or files.'),
      }),
      execute: ({ query }) =>
        attempt('search_workspace', () => search(query, { workspaceId: opts.workspaceId })),
    }),
  }
}
