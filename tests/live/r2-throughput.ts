/**
 * Raw R2 link probe. NOT the benchmark.
 *
 *   CHECKPOINT_LIVE_R2=1 MB=42 bun run tests/live/r2-throughput.ts
 *
 * Uploads and downloads a random blob to establish this machine's ceiling, so
 * the transfer numbers in checkpoint-bench.ts can be read as "Checkpoint hit
 * line rate" or "Checkpoint added overhead" rather than guessed at. Random
 * bytes are correct here precisely because this measures the link and nothing
 * about Memvid.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LIVE, liveStorage, mib, rate } from './support'

if (!LIVE) {
  console.error('[r2-throughput] refusing to run without CHECKPOINT_LIVE_R2=1')
  process.exit(2)
}

const megabytes = Number(process.env.MB ?? 42)
const dir = await mkdtemp(join(tmpdir(), 'r2-throughput-'))
const src = join(dir, 'blob.bin')
await Bun.$`dd if=/dev/urandom of=${src} bs=1m count=${megabytes} status=none`

const size = (await stat(src)).size
const storage = liveStorage()
const key = `_live/netprobe/${crypto.randomUUID()}.bin`

try {
  let t = performance.now()
  await storage.putFileIfMatch(key, src, null)
  const up = performance.now() - t
  console.log(`upload   ${mib(size)} MiB in ${(up / 1000).toFixed(1)} s = ${rate(size, up)} MiB/s`)

  t = performance.now()
  await storage.getToFile(key, join(dir, 'down.bin'))
  const down = performance.now() - t
  console.log(`download ${mib(size)} MiB in ${(down / 1000).toFixed(1)} s = ${rate(size, down)} MiB/s`)
} finally {
  await storage.delete(key).catch(() => {})
  const leftover = await storage.list('_live/netprobe/')
  console.log(`cleanup: ${leftover.length} objects left under _live/netprobe/`)
  await rm(dir, { recursive: true, force: true })
}
