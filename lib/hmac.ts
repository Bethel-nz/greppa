import { createHmac, timingSafeEqual } from 'node:crypto'

export function signSessionId(sessionId: string, secret: string): string {
  return createHmac('sha256', secret).update(sessionId).digest('hex')
}

export function verifySessionId(sessionId: string, sig: string, secret: string): boolean {
  if (!sig || sig.length !== 64 || !/^[0-9a-f]+$/.test(sig)) return false
  const expected = signSessionId(sessionId, secret)
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(sig, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}