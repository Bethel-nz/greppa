import { createDeterministicProvider } from './deterministic'
import { createGoogleProvider } from './google'
import { createOpenAICompatibleProvider } from './openai-compatible'
import { createOpenRouterProvider } from './openrouter'
import type { EmbeddingProvider } from './provider'

export * from './provider'

let cached: EmbeddingProvider | null = null

function build(): EmbeddingProvider {
  const kind = process.env.EMBEDDING_PROVIDER ?? 'deterministic'
  const model = process.env.EMBEDDING_MODEL
  const dimension = process.env.EMBEDDING_DIM ? Number(process.env.EMBEDDING_DIM) : undefined

  if (dimension !== undefined && (!Number.isInteger(dimension) || dimension <= 0)) {
    throw new Error(`[embedding] EMBEDDING_DIM must be a positive integer, got "${process.env.EMBEDDING_DIM}"`)
  }

  switch (kind) {
    case 'openrouter': {
      const apiKey = process.env.OPENROUTER_API_KEY
      if (!apiKey) throw new Error('[embedding] OPENROUTER_API_KEY is required for EMBEDDING_PROVIDER=openrouter')
      return createOpenRouterProvider({ apiKey, model, dimension })
    }
    case 'google': {
      const apiKey = process.env.GOOGLE_API_KEY
      if (!apiKey) throw new Error('[embedding] GOOGLE_API_KEY is required for EMBEDDING_PROVIDER=google')
      return createGoogleProvider({ apiKey, model, dimension })
    }
    // Any OpenAI-compatible /v1/embeddings endpoint: OpenAI itself, NVIDIA NIM,
    // or a self-hosted inference server. Use EMBEDDING_PROVIDER=openrouter for
    // OpenRouter — its embeddings endpoint takes a different multimodal input
    // shape and needs the ":free" model suffix.
    case 'openai-compatible': {
      const apiKey = process.env.EMBEDDING_API_KEY
      const baseUrl = process.env.EMBEDDING_BASE_URL
      if (!apiKey) throw new Error('[embedding] EMBEDDING_API_KEY is required for EMBEDDING_PROVIDER=openai-compatible')
      if (!baseUrl) throw new Error('[embedding] EMBEDDING_BASE_URL is required for EMBEDDING_PROVIDER=openai-compatible')
      if (!model) throw new Error('[embedding] EMBEDDING_MODEL is required for EMBEDDING_PROVIDER=openai-compatible')
      if (!dimension) throw new Error('[embedding] EMBEDDING_DIM is required for EMBEDDING_PROVIDER=openai-compatible')
      return createOpenAICompatibleProvider({
        apiKey,
        baseUrl,
        model,
        dimension,
        sendInputType: process.env.EMBEDDING_SEND_INPUT_TYPE !== '0',
      })
    }
    case 'deterministic':
      return createDeterministicProvider(dimension ?? 128)
    default:
      throw new Error(
        `[embedding] unknown EMBEDDING_PROVIDER "${kind}" (openrouter | google | openai-compatible | deterministic)`,
      )
  }
}

export function getEmbeddingProvider(): EmbeddingProvider {
  if (!cached) cached = build()
  return cached
}

/** Test seam: drop the memoised provider so env changes take effect. */
export function resetEmbeddingProvider(): void {
  cached = null
}
