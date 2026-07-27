export const CHUNK_TARGET_CHARS = 1000
export const CHUNK_OVERLAP_CHARS = 150

export type ChunkOptions = { targetChars?: number; overlapChars?: number }

/** Split on paragraphs, then sentences, then a hard cut, in that order. */
function segment(text: string, max: number): string[] {
  const out: string[] = []
  for (const para of text.split(/\n{2,}/)) {
    const trimmed = para.trim()
    if (!trimmed) continue
    if (trimmed.length <= max) {
      out.push(trimmed)
      continue
    }
    let buffer = ''
    for (const sentence of trimmed.split(/(?<=[.!?])\s+/)) {
      if (sentence.length > max) {
        if (buffer) {
          out.push(buffer)
          buffer = ''
        }
        for (let i = 0; i < sentence.length; i += max) out.push(sentence.slice(i, i + max))
        continue
      }
      if (buffer.length + sentence.length + 1 > max) {
        out.push(buffer)
        buffer = sentence
      } else {
        buffer = buffer ? `${buffer} ${sentence}` : sentence
      }
    }
    if (buffer) out.push(buffer)
  }
  return out
}

/**
 * Split text into retrieval-sized chunks. Long documents embedded whole average
 * into an unusable vector, so webpages and PDFs must be chunked before
 * embedding. Short notes and chat messages fall through as a single chunk.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const target = opts.targetChars ?? CHUNK_TARGET_CHARS
  const overlap = opts.overlapChars ?? CHUNK_OVERLAP_CHARS
  if (!text.trim()) return []

  const pieces = segment(text, target)
  if (pieces.length <= 1) return pieces

  const out: string[] = []
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!
    if (i === 0 || overlap <= 0) {
      out.push(piece)
      continue
    }
    const carry = pieces[i - 1]!.slice(-overlap)
    out.push(`${carry} ${piece}`.trim())
  }
  return out.filter((c) => c.trim().length > 0)
}
