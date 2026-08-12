import { type EmbeddingProvider, type EmbedKind, l2normalize } from './provider'

function hash(token: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

export function createDeterministicProvider(dimension = 128): EmbeddingProvider {
  const embedOne = (text: string): Float32Array => {
    const v = new Float32Array(dimension)
    for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      const h = hash(token)
      v[h % dimension] += 1
      v[(h >>> 8) % dimension] += 0.5
    }
    return l2normalize(v)
  }

  return {
    id: `deterministic@${dimension}`,
    dimension,
    maxBatchSize: 256,
    async embed(texts: string[], _kind: EmbedKind): Promise<Float32Array[]> {
      return texts.map(embedOne)
    },
    async embedImage(assets): Promise<Float32Array[]> {
      return assets.map((a) => embedOne(`image:${a.mime}:${a.bytes.byteLength}`))
    },
  }
}
