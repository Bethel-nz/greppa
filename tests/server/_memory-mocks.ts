import { mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Checkpoint } from '~/utils/checkpoint/checkpoint'
import { MemoryStorage } from '~/utils/checkpoint/storage'
import { NotFoundError } from '~/utils/checkpoint/errors'

export const cacheDir = mkdtempSync(join(tmpdir(), 'scoped-cp-'))
export const sharedStorage = new MemoryStorage()
export const sharedCp = new Checkpoint({
  storage: sharedStorage,
  cacheDir,
  maxOpen: 8,
  idleMs: 60_000,
})

process.on('exit', () => rmSync(cacheDir, { recursive: true, force: true }))

class ScopeAccessError extends Error {}
mock.module('../../lib/memory/scope', () => ({
  getOrCreatePersonalScope: async (userId: string) => `scope-${userId}`,
  scopeObjectKey: (scopeId: string) => `scopes/${scopeId}/memory.sqlite`,
  orgScopeObjectKey: (orgId: string) => `orgs/${orgId}/memory.sqlite`,
  assertScopeAccess: async () => {},
  ScopeAccessError,
}))

mock.module('../../utils/checkpoint', () => ({
  getCheckpoint: () => sharedCp,
  NotFoundError,
}))

let answerCalls = 0
export const getAnswerCalls = () => answerCalls
mock.module('../../lib/memory/answer', () => ({
  generateAnswer: async ({ context }: { context: string }) => {
    answerCalls += 1
    const first = context.split('\n\n')[0] ?? ''
    return first.split('\n').slice(1).join('\n')
  },
}))

let n = 0
export const freshUser = () => `u${Date.now()}-${n++}`

const realScopedService = await import('../../lib/memory/scoped-service')

type ScopedServiceOverrides = Partial<typeof realScopedService>
let overrides: ScopedServiceOverrides | null = null

export function interceptScopedService(next: ScopedServiceOverrides | null) {
  overrides = next
}

mock.module('../../lib/memory/scoped-service', () => {
  const forwarding: Record<string, unknown> = {}
  for (const name of Object.keys(realScopedService)) {
    const real = (realScopedService as Record<string, unknown>)[name]
    if (typeof real !== 'function') {
      forwarding[name] = real
      continue
    }
    forwarding[name] = (...args: unknown[]) => {
      const override = overrides?.[name as keyof ScopedServiceOverrides] as
        | ((...a: unknown[]) => unknown)
        | undefined
      return (override ?? (real as (...a: unknown[]) => unknown))(...args)
    }
  }
  return forwarding
})
