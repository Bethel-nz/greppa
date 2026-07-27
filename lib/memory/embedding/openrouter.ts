import { type EmbeddingProvider, type EmbedKind, l2normalize } from './provider'

/**
 * Nemotron Embed VL 1B v2 via OpenRouter's /api/v1/embeddings endpoint.
 * Multimodal: text, image, or both in a single input. 2048 dimensions.
 *
 * Verified against the live endpoint on 2026-07-25:
 *   plain-string input                  -> 200, dim 2048, norm 0.99975
 *   structured {content:[...]} input    -> 200, dim 2048
 *   base64 data: URL image              -> 200, dim 2048, norm 1.00017
 *   text + image combined in one input  -> 200, dim 2048
 *
 * The `:free` suffix on the model id is required — the bare id returns
 * "No endpoints found". Vectors arrive very close to unit length already, but
 * l2normalize still runs: the store compares with dot product and a 0.9997-norm
 * vector skews scores slightly, while a future model change could skew them a
 * lot without any error surfacing.
 */
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
        // Not optional. Verified 2026-07-25: omitting input_type produces a
        // vector byte-identical to input_type "query", while "passage" differs.
        // So the default embeds everything as a query, and documents indexed
        // without this are in the wrong half of an asymmetric model's space.
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
