import { Redis } from '@upstash/redis'

let _redis: Redis | null = null

export function getRedis(): Redis {
  if (!_redis) {
    if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
      throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required')
    }
    _redis = Redis.fromEnv()
  }
  return _redis
}

export const redis: Redis = new Proxy({} as Redis, {
  get(_t, prop) {
    return (getRedis() as any)[prop]
  },
})