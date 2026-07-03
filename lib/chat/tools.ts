import { tool } from 'ai'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { redis } from '~/lib/redis'
import type { makeEmitter } from '~/lib/emit'
import { scanRetrievedSnippet } from '~/lib/security'
import { addScopedMemory, askScopedMemory } from '~/lib/memory/scoped-service'

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
}) {
  return {
    search_knowledge: tool({
      description: "Search the user's stored knowledge and long-term memory for relevant context.",
      inputSchema: z.object({
        query: z.string().describe('A precise search query targeting the information needed.'),
      }),
      execute: async ({ query }) => {
        await opts.emit('cue', { status: 'searching_knowledge', at: Date.now(), query })
        const result = await askScopedMemory({ userId: opts.userId, question: query, limit: 5 })
        const sources: ChatSource[] = (result.sources ?? []).map((s: any) => ({
          title: s.title,
          snippet: s.snippet,
          score: s.score,
        }))
        opts.onSources(sources)
        await opts.emit('cue', { status: 'reading_sources', at: Date.now(), count: sources.length })
        await opts.emit('sources', sources)
        return scanRetrievedSnippet(result.context ?? 'No relevant information found.')
      },
    }),
    remember: tool({
      description:
        "Store an important, durable fact from the conversation into the user's long-term memory for future recall. Use only for information worth remembering across sessions, not casual chatter.",
      inputSchema: z.object({
        title: z.string().describe('A short title for the fact.'),
        text: z.string().describe('The fact to remember, stated clearly and self-contained.'),
      }),
      execute: async ({ title, text }) => {
        // Idempotency: the agent loop runs outside workflow.run, so a replay would
        // re-execute this tool. Dedupe on a content hash so the write happens once.
        const hash = createHash('sha256').update(`${title}\n${text}`).digest('hex')
        const fresh = await redis.set(`mem:written:${opts.userId}:${hash}`, '1', { nx: true, ex: 3600 })
        if (fresh !== 'OK') return 'Already saved (duplicate).'
        await addScopedMemory({ userId: opts.userId, title, text, sourceType: 'chat' })
        return 'Saved to your memory.'
      },
    }),
  }
}
