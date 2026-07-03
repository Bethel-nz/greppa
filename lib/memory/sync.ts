import { stat } from 'node:fs/promises'
import {
  uploadMemoryToR2,
  uploadMemorySnapshot,
  listR2Snapshots,
  deleteR2Object,
  R2_MEMORY_KEY,
} from './r2'
import { LOCAL_MEMORY_PATH } from './memvid'
import { enqueueMemoryWrite } from './queue'
import { drizzle, schema } from '../db'

const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
const MAX_SNAPSHOTS = 24
const SNAPSHOT_PREFIX = `${R2_MEMORY_KEY}.snapshot-`

let snapshotTimer: ReturnType<typeof setInterval> | null = null
let dirtySinceLastSnapshot = false

/** Marked by every committed write so idle snapshots are skipped. */
export function markMemoryDirty(): void {
  dirtySinceLastSnapshot = true
}

async function pruneSnapshots(): Promise<void> {
  const snapshots = await listR2Snapshots(SNAPSHOT_PREFIX)
  if (snapshots.length <= MAX_SNAPSHOTS) return

  const sorted = snapshots.sort(
    (a, b) => (a.lastModified?.getTime() ?? 0) - (b.lastModified?.getTime() ?? 0),
  )
  const stale = sorted.slice(0, sorted.length - MAX_SNAPSHOTS)
  for (const entry of stale) {
    await deleteR2Object(entry.key)
  }
}

async function runSnapshot(): Promise<void> {
  if (!dirtySinceLastSnapshot) return
  dirtySinceLastSnapshot = false

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const snapshotKey = `${SNAPSHOT_PREFIX}${timestamp}`

  // Read + upload inside the write queue so we never capture a file mid-write.
  const size = await enqueueMemoryWrite(async () => {
    await uploadMemorySnapshot(LOCAL_MEMORY_PATH, snapshotKey)
    await uploadMemoryToR2(LOCAL_MEMORY_PATH)
    const file = await stat(LOCAL_MEMORY_PATH)
    return file.size
  })

  await drizzle.insert(schema.memorySnapshots).values({
    id: crypto.randomUUID(),
    objectKey: snapshotKey,
    sizeBytes: size,
  })

  await pruneSnapshots()
  console.log(`[bg-sync] snapshot uploaded: ${snapshotKey}`)
}

export function startBackgroundSync() {
  if (snapshotTimer) return
  console.log('[bg-sync] starting background R2 snapshot sync every 5min')

  snapshotTimer = setInterval(() => {
    runSnapshot().catch((err) => console.error('[bg-sync] snapshot failed:', err))
  }, SNAPSHOT_INTERVAL_MS)
}

export function stopBackgroundSync() {
  if (snapshotTimer) {
    clearInterval(snapshotTimer)
    snapshotTimer = null
    console.log('[bg-sync] stopped')
  }
}

// Auto-start in production only (inert in dev/test).
if (process.env.NODE_ENV === 'production') {
  startBackgroundSync()
}
