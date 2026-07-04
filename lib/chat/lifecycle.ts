import { redis } from '~/lib/redis'

const TERMINAL_STATUS = new Set(['done', 'error'])

// Guards a workflow run against QStash redelivery. If the message already reached a
// terminal status, the run is a duplicate and must no-op (leaving the completed log
// intact). Otherwise it is a fresh attempt, so the events log is reset to a clean
// slate before this attempt starts streaming.
export async function beginRun({ messageId, ttlMs }: { messageId: string; ttlMs: number }): Promise<{ skip: boolean }> {
  const meta = (await redis.hgetall(`msg:${messageId}:meta`)) as { status?: string } | null
  if (meta?.status && TERMINAL_STATUS.has(meta.status)) return { skip: true }
  await redis.del(`msg:${messageId}:events`)
  await redis.expire(`msg:${messageId}:meta`, Math.floor(ttlMs / 1000))
  return { skip: false }
}

// Writes meta fields and re-anchors the meta TTL to ttlMs on every write, so the
// resume gate expires ttlMs after the last activity rather than at enqueue time.
export async function setMeta({
  messageId,
  ttlMs,
  fields,
}: {
  messageId: string
  ttlMs: number
  fields: Record<string, string | number>
}): Promise<void> {
  await redis.hset(`msg:${messageId}:meta`, fields)
  await redis.expire(`msg:${messageId}:meta`, Math.floor(ttlMs / 1000))
}
