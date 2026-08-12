import { type EmbeddingProvider, type EmbedKind, l2normalize } from './provider'

const DEFAULT_MODEL = 'gemini-embedding-001'
const DEFAULT_DIMENSION = 1536
const BASE = process.env.GOOGLE_EMBEDDINGS_URL ?? 'https://generativelanguage.googleapis.com/v1beta'

export type GoogleConfig = { apiKey: string; model?: string; dimension?: number }

export function createGoogleProvider(cfg: GoogleConfig): EmbeddingProvider {
  const model = cfg.model ?? DEFAULT_MODEL
  const dimension = cfg.dimension ?? DEFAULT_DIMENSION

  return {
    id: `google/${model}@${dimension}`,
    dimension,
    maxBatchSize: 100,
    async embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
      if (texts.length === 0) return []
      const taskType = kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT'
      const res = await fetch(`${BASE}/models/${model}:batchEmbedContents?key=${cfg.apiKey}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: dimension,
          })),
        }),
      })
      if (!res.ok) {
        throw new Error(`[embedding] google ${res.status}: ${(await res.text()).slice(0, 300)}`)
      }
      const body = (await res.json()) as { embeddings?: Array<{ values: number[] }> }
      if (!body.embeddings || body.embeddings.length !== texts.length) {
        throw new Error(
          `[embedding] google returned ${body.embeddings?.length ?? 0} vectors for ${texts.length} inputs`,
        )
      }
      return body.embeddings.map((e) => {
        if (e.values.length !== dimension) {
          throw new Error(`[embedding] expected dimension ${dimension}, got ${e.values.length}`)
        }
        return l2normalize(Float32Array.from(e.values))
      })
    },
  }
}
