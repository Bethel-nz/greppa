import { redis } from '~/lib/redis'

const TERMINAL_STATUS = new Set(['done', 'error'])

export async function beginRun({ messageId, ttlMs }: { messageId: string; ttlMs: number }): Promise<{ skip: boolean }> {
  const meta = (await redis.hgetall(`msg:${messageId}:meta`)) as { status?: string } | null
  if (meta?.status && TERMINAL_STATUS.has(meta.status)) return { skip: true }
  await redis.del(`msg:${messageId}:events`)
  await redis.expire(`msg:${messageId}:meta`, Math.floor(ttlMs / 1000))
  return { skip: false }
}

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
