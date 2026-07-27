import { type EmbeddingProvider, type EmbedKind, l2normalize } from './provider'

/**
 * Adapter for any endpoint speaking the OpenAI `/v1/embeddings` shape:
 * `{ model, input: string[] }` in, `{ data: [{ embedding: number[] }] }` out.
 *
 * That covers OpenAI itself, NVIDIA NIM (https://integrate.api.nvidia.com/v1),
 * and most self-hosted inference servers. It deliberately does NOT cover
 * OpenRouter: OpenRouter is a chat/completion router and serves no embedding
 * models at all (verified 2026-07-25 — its /api/v1/models returns 345 models,
 * none with an embedding output modality).
 *
 * Nemotron Embed VL 1B v2 is reachable this way through NVIDIA NIM:
 *   baseUrl "https://integrate.api.nvidia.com/v1"
 *   model   "nvidia/llama-nemotron-embed-vl-1b-v2"
 *   dimension 2048
 */
export type OpenAICompatibleConfig = {
  apiKey: string
  baseUrl: string
  model: string
  dimension: number
  /** Sent as `input_type`; NIM and Nemotron use it for asymmetric retrieval. */
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
      // Normalize regardless of what upstream claims: the store compares with
      // dot product, and an unnormalized vector is silently wrong, not an error.
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
