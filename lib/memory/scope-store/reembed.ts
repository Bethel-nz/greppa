import type { Database } from 'bun:sqlite'
import { type EmbeddingProvider, embedInBatches } from '../embedding/provider'
import { writeIdentity } from './schema'

export type ReembedOptions = {
  /** Fetch original image bytes so image chunks can be re-embedded. */
  getAsset?: (sha256: string) => Promise<{ bytes: Uint8Array; mime: string } | null>
}

type ChunkRow = {
  id: number
  text: string
  modality: string
  asset_sha256: string | null
  asset_mime: string | null
}

/**
 * Rebuild every vector under a new provider.
 *
 * Only the derived vectors change: documents, chunks, chunks_fts and every
 * asset are untouched, so BM25 search keeps working throughout and no source is
 * re-fetched. vec0 cannot be altered in place, so the table is dropped and
 * recreated at the new dimension.
 *
 * Call this inside a single Checkpoint.write so the migration is atomic,
 * compare-and-set protected, and costs one upload.
 */
export async function reembedScope(
  db: Database,
  next: EmbeddingProvider,
  opts: ReembedOptions = {},
): Promise<number> {
  const chunks = db
    .prepare('select id, text, modality, asset_sha256, asset_mime from chunks order by id')
    .all() as ChunkRow[]

  const vectors = new Map<number, Float32Array>()

  // Embedding happens before the transaction: it is network-bound, and holding
  // a write transaction open across it would serialise the whole file on a
  // remote API's latency.
  const textChunks = chunks.filter((c) => c.modality !== 'image')
  if (textChunks.length) {
    const embedded = await embedInBatches(next, textChunks.map((c) => c.text), 'document')
    textChunks.forEach((c, i) => vectors.set(c.id, embedded[i]!))
  }

  for (const c of chunks.filter((c) => c.modality === 'image')) {
    if (!next.embedImage || !opts.getAsset || !c.asset_sha256) {
      throw new Error(
        `[scope-store] chunk ${c.id} is an image but the target provider or asset loader cannot re-embed it`,
      )
    }
    const asset = await opts.getAsset(c.asset_sha256)
    if (!asset) {
      throw new Error(`[scope-store] asset ${c.asset_sha256} is missing; cannot re-embed chunk ${c.id}`)
    }
    const [vector] = await next.embedImage([asset])
    vectors.set(c.id, vector!)
  }

  const rebuild = db.transaction(() => {
    db.run('drop table if exists chunks_vec')
    db.run(`create virtual table chunks_vec using vec0(embedding float[${next.dimension}])`)
    const insert = db.prepare('insert into chunks_vec(rowid, embedding) values (?, ?)')
    for (const [id, v] of vectors) {
      insert.run(id, Buffer.from(v.buffer, v.byteOffset, v.byteLength))
    }
    writeIdentity(db, next)
  })

  rebuild()
  return vectors.size
}
