import { stat } from 'node:fs/promises'

export async function getMemvidLocalStats() {
  const path = process.env.MEMVID_LOCAL_PATH ?? './.greppa/memory/app.mv2'
  try {
    const file = await stat(path)
    return {
      exists: true,
      path,
      sizeBytes: file.size,
      modifiedAt: file.mtime.toISOString(),
    }
  } catch {
    return {
      exists: false,
      path,
      sizeBytes: 0,
      modifiedAt: null,
    }
  }
}
