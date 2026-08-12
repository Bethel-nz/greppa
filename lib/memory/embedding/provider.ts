export class EmbeddingIdentityError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `[scope-store] embedding identity mismatch: file was written with "${expected}" ` +
        `but the configured provider is "${actual}". Vectors from different models are not ` +
        `comparable; run reembedScope() to migrate this scope.`,
    )
    this.name = 'EmbeddingIdentityError'
  }
}

export function l2normalize(v: Float32Array): Float32Array {
  let sum = 0
  for (const x of v) sum += x * x
  if (sum === 0) return v
  const inv = 1 / Math.sqrt(sum)
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i]! * inv
  return out
}

export type EmbedKind = 'document' | 'query'

export interface EmbeddingProvider {
  readonly id: string
  readonly dimension: number
  readonly maxBatchSize: number
  embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]>
  embedImage?(assets: Array<{ bytes: Uint8Array; mime: string }>): Promise<Float32Array[]>
}

export async function embedInBatches(
  provider: EmbeddingProvider,
  texts: string[],
  kind: EmbedKind,
): Promise<Float32Array[]> {
  const out: Float32Array[] = []
  for (let i = 0; i < texts.length; i += provider.maxBatchSize) {
    out.push(...(await provider.embed(texts.slice(i, i + provider.maxBatchSize), kind)))
  }
  return out
}
