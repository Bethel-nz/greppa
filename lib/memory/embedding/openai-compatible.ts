import { type EmbeddingProvider, type EmbedKind, l2normalize } from './provider'

export type OpenAICompatibleConfig = {
  apiKey: string
  baseUrl: string
  model: string
  dimension: number
  sendInputType?: boolean
  maxBatchSize?: number
}

export function createOpenAICompatibleProvider(cfg: OpenAICompatibleConfig): EmbeddingProvider {
  const endpoint = `${cfg.baseUrl.replace(/\/$/, '')}/embeddings`

  const request = async (input: unknown[], kind: EmbedKind): Promise<Float32Array[]> => {
    if (input.length === 0) return []
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        input,
        ...(cfg.sendInputType ? { input_type: kind === 'query' ? 'query' : 'passage' } : {}),
      }),
    })
    if (!res.ok) {
      throw new Error(`[embedding] ${endpoint} ${res.status}: ${(await res.text()).slice(0, 300)}`)
    }
    const body = (await res.json()) as { data?: Array<{ embedding: number[] }> }
    if (!body.data || body.data.length !== input.length) {
      throw new Error(
        `[embedding] ${endpoint} returned ${body.data?.length ?? 0} vectors for ${input.length} inputs`,
      )
    }
    return body.data.map((d) => {
      if (d.embedding.length !== cfg.dimension) {
        throw new Error(`[embedding] expected dimension ${cfg.dimension}, got ${d.embedding.length}`)
      }
      return l2normalize(Float32Array.from(d.embedding))
    })
  }

  return {
    id: `${cfg.model}@${cfg.dimension}`,
    dimension: cfg.dimension,
    maxBatchSize: cfg.maxBatchSize ?? 32,
    embed: (texts, kind) => request(texts, kind),
    embedImage: (assets) =>
      request(
        assets.map((a) => ({
          image: `data:${a.mime};base64,${Buffer.from(a.bytes).toString('base64')}`,
        })),
        'document',
      ),
  }
}
