import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { use, create, open } from '@memvid/sdk'
import type { Memvid } from '@memvid/sdk'
import { downloadMemoryFromR2, uploadMemoryToR2 } from './r2'

export const LOCAL_MEMORY_PATH =
  process.env.MEMVID_LOCAL_PATH ?? './.greppa/memory/app.mv2'

// Single-instance handle cache. Reads reuse this handle instead of re-opening
// the file per request; writes invalidate it after seal so the next access
// reflects the sealed on-disk state. See invalidateGreppaMemory().
let cachedMem: Memvid | null = null

async function openHandle(): Promise<Memvid> {
  if (!existsSync(LOCAL_MEMORY_PATH)) {
    const downloaded = await downloadMemoryFromR2(LOCAL_MEMORY_PATH)

    if (!downloaded) {
      await mkdir(dirname(LOCAL_MEMORY_PATH), { recursive: true })
      // Try SDK create() first, fall back to use() with mode
      let mem: Memvid
      try {
        mem = await create(LOCAL_MEMORY_PATH, 'basic', {
          enableLex: true,
          enableVec: true,
        })
      } catch {
        mem = await use('basic', LOCAL_MEMORY_PATH, { mode: 'create' })
      }
      await mem.seal()
      await uploadMemoryToR2(LOCAL_MEMORY_PATH)
    }
  }

  // await so the try/catch can actually catch a failed open (async rejection).
  try {
    return await open(LOCAL_MEMORY_PATH, 'basic')
  } catch {
    return await use('basic', LOCAL_MEMORY_PATH)
  }
}

export async function openGreppaMemory(): Promise<Memvid> {
  if (cachedMem) return cachedMem
  cachedMem = await openHandle()
  return cachedMem
}

/**
 * Drop the cached handle so the next openGreppaMemory() re-opens from disk.
 * Call after a write seals + uploads, so subsequent reads see the sealed state.
 */
export function invalidateGreppaMemory(): void {
  cachedMem = null
}

export async function getGreppaMemoryReader() {
  return openGreppaMemory()
}
