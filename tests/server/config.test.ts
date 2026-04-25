import { describe, expect, test, beforeEach } from 'bun:test'
import { _resetGreppaConfigForTests } from '../../lib/config'

describe('greppa config', () => {
  beforeEach(() => {
    _resetGreppaConfigForTests()
    delete process.env.GREPPA_SESSION_SECRET
    delete process.env.GREPPA_DEPLOYER_KEY
    delete process.env.GREPPA_SESSION_TTL_MS
    delete process.env.GREPPA_MESSAGE_TTL_MS
    delete process.env.GREPPA_ALLOW_PUBLIC_DELETE
    delete process.env.GREPPA_ALLOW_PUBLIC_STATS
  })

  test('throws if GREPPA_SESSION_SECRET missing', async () => {
    const { loadGreppaConfig } = await import('../../lib/config')
    expect(() => loadGreppaConfig()).toThrow(/GREPPA_SESSION_SECRET/)
  })

  test('uses defaults for ttls and flags', async () => {
    process.env.GREPPA_SESSION_SECRET = 'a'.repeat(32)
    const mod = await import('../../lib/config?defaults' as any).catch(async () => await import('../../lib/config'))
    const cfg = mod.loadGreppaConfig()
    expect(cfg.sessionTtlMs).toBe(1000 * 60 * 60 * 24 * 2)
    expect(cfg.messageTtlMs).toBe(1000 * 60 * 60)
    expect(cfg.allowPublicDelete).toBe(false)
    expect(cfg.allowPublicStats).toBe(false)
    expect(cfg.deployerKey).toBeUndefined()
  })

  test('parses overrides from env', async () => {
    process.env.GREPPA_SESSION_SECRET = 'b'.repeat(32)
    process.env.GREPPA_DEPLOYER_KEY = 'deployer'
    process.env.GREPPA_SESSION_TTL_MS = '60000'
    process.env.GREPPA_MESSAGE_TTL_MS = '5000'
    process.env.GREPPA_ALLOW_PUBLIC_DELETE = 'true'
    process.env.GREPPA_ALLOW_PUBLIC_STATS = '1'
    const { loadGreppaConfig } = await import('../../lib/config')
    const cfg = loadGreppaConfig()
    expect(cfg.sessionTtlMs).toBe(60000)
    expect(cfg.messageTtlMs).toBe(5000)
    expect(cfg.allowPublicDelete).toBe(true)
    expect(cfg.allowPublicStats).toBe(true)
    expect(cfg.deployerKey).toBe('deployer')
  })
})