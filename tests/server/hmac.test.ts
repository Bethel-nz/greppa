import { describe, expect, test } from 'bun:test'
import { signSessionId, verifySessionId } from '~/lib/hmac'

const SECRET = 'a'.repeat(48)

describe('hmac', () => {
  test('sign produces hex of length 64', () => {
    const sig = signSessionId('01HXXX', SECRET)
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
  })

  test('verify accepts valid signature', () => {
    const sig = signSessionId('01HXXX', SECRET)
    expect(verifySessionId('01HXXX', sig, SECRET)).toBe(true)
  })

  test('verify rejects tampered id', () => {
    const sig = signSessionId('01HXXX', SECRET)
    expect(verifySessionId('01HYYY', sig, SECRET)).toBe(false)
  })

  test('verify rejects wrong secret', () => {
    const sig = signSessionId('01HXXX', SECRET)
    expect(verifySessionId('01HXXX', sig, 'b'.repeat(48))).toBe(false)
  })

  test('verify rejects malformed sig', () => {
    expect(verifySessionId('01HXXX', 'not-hex', SECRET)).toBe(false)
    expect(verifySessionId('01HXXX', '', SECRET)).toBe(false)
  })
})