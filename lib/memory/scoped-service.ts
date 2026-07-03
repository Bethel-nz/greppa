import { create, open, use } from '@memvid/sdk'
import type { Memvid } from '@memvid/sdk'
import { getCheckpoint } from '~/utils/checkpoint'
import { NotFoundError } from '~/utils/checkpoint'
import { getOrCreatePersonalScope, scopeObjectKey } from './scope'

export type ScopedSourceType = 'note' | 'chat' | 'document' | 'webpage' | 'agent_event'

export type AddScopedMemoryInput = {
  userId: string
  title: string
  text: string
  sourceType?: ScopedSourceType
  sourceUrl?: string
}

export type SearchScopedMemoryInput = {
  userId: string
  query: string
  limit?: number
}

export type AskScopedMemoryInput = {
  userId: string
  question: string
  limit?: number
}

/** Open an existing scope file read-only, mirroring the robustness of the
 * legacy path (open() with a use() fallback across SDK versions). */
async function openReadOnly(localPath: string): Promise<Memvid> {
  try {
    return await open(localPath, 'basic', { readOnly: true })
  } catch {
    return await use('basic', localPath)
  }
}

/**
 * Append a memory to the caller's personal scope. The Memvid handle is opened,
 * written, and sealed entirely inside the checkpoint write callback so the
 * uploaded bytes are always a sealed file (see Checkpoint.write contract).
 */
export async function addScopedMemory(input: AddScopedMemoryInput) {
  const scopeId = await getOrCreatePersonalScope(input.userId)
  const key = scopeObjectKey(scopeId)
  const sourceType = input.sourceType ?? 'note'

  const frameId = await getCheckpoint().write(key, async (localPath, exists) => {
    const mem = exists
      ? await use('basic', localPath)
      : await create(localPath, 'basic', { enableLex: true, enableVec: true })

    const id = await mem.put({
      title: input.title,
      label: sourceType,
      text: input.text,
      metadata: {
        source_type: sourceType,
        source_url: input.sourceUrl,
        created_by: input.userId,
        app: 'greppa',
      },
    })

    await mem.seal()
    return id
  })

  return { scopeId, frameId, status: 'indexed' as const }
}

export async function searchScopedMemory(input: SearchScopedMemoryInput) {
  const scopeId = await getOrCreatePersonalScope(input.userId)
  const key = scopeObjectKey(scopeId)

  try {
    return await getCheckpoint().read(key, async (localPath) => {
      const mem = await openReadOnly(localPath)
      return mem.find(input.query, { k: input.limit ?? 8 })
    })
  } catch (err) {
    // No memory written yet for this scope -> empty result, not an error.
    if (err instanceof NotFoundError) return { hits: [], total_hits: 0 }
    throw err
  }
}

export async function askScopedMemory(input: AskScopedMemoryInput) {
  const scopeId = await getOrCreatePersonalScope(input.userId)
  const key = scopeObjectKey(scopeId)

  try {
    return await getCheckpoint().read(key, async (localPath) => {
      const mem = await openReadOnly(localPath)
      return mem.ask(input.question, { k: input.limit ?? 10 })
    })
  } catch (err) {
    // No memory written yet -> empty answer with the same shape mem.ask() returns.
    if (err instanceof NotFoundError) {
      return { answer: null, sources: [], context: '', grounding: null }
    }
    throw err
  }
}
