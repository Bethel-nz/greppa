import { type EmbeddingProvider, type EmbedKind, l2normalize } from './provider'

const DEFAULT_MODEL = 'nvidia/llama-nemotron-embed-vl-1b-v2:free'
const DEFAULT_DIMENSION = 2048
const ENDPOINT = process.env.OPENROUTER_EMBEDDINGS_URL ?? 'https://openrouter.ai/api/v1/embeddings'

export type OpenRouterConfig = { apiKey: string; model?: string; dimension?: number }

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
type EmbedInput = string | { content: ContentPart[] }

export function createOpenRouterProvider(cfg: OpenRouterConfig): EmbeddingProvider {
  const model = cfg.model ?? DEFAULT_MODEL
  const dimension = cfg.dimension ?? DEFAULT_DIMENSION

  const request = async (input: EmbedInput[], kind: EmbedKind): Promise<Float32Array[]> => {
    if (input.length === 0) return []
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        input,
        encoding_format: 'float',
        input_type: kind === 'query' ? 'query' : 'passage',
      }),
    })
    if (!res.ok) {
      throw new Error(`[embedding] openrouter ${res.status}: ${(await res.text()).slice(0, 300)}`)
    }
    const body = (await res.json()) as { data?: Array<{ embedding: number[] }> }
    if (!body.data || body.data.length !== input.length) {
      throw new Error(
        `[embedding] openrouter returned ${body.data?.length ?? 0} vectors for ${input.length} inputs`,
      )
    }
    return body.data.map((d) => {
      if (d.embedding.length !== dimension) {
        throw new Error(`[embedding] expected dimension ${dimension}, got ${d.embedding.length}`)
      }
      return l2normalize(Float32Array.from(d.embedding))
    })
  }

  return {
    id: `${model}@${dimension}`,
    dimension,
    maxBatchSize: 32,
    embed: (texts, kind) => request(texts, kind),
    embedImage: (assets) =>
      request(
        assets.map((a) => ({
          content: [
            {
              type: 'image_url' as const,
              image_url: { url: `data:${a.mime};base64,${Buffer.from(a.bytes).toString('base64')}` },
            },
          ],
        })),
        'document',
      ),
  }
}
