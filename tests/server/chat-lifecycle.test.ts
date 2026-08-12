import './_mocks'
import { describe, expect, test, beforeEach } from 'bun:test'
import { fakeRedis, zsets, clearRedisState } from './_mocks'
import { beginRun, setMeta } from '~/lib/chat/lifecycle'

describe('chat lifecycle', () => {
  beforeEach(() => clearRedisState())

  test('beginRun skips when meta status is terminal', async () => {
    fakeRedis['msg:m1:meta'] = { conversationId: 's', status: 'done' }
    zsets['msg:m1:events'] = [{ score: 1, member: '{}' }]
    const { skip } = await beginRun({ messageId: 'm1', ttlMs: 300000 })
    expect(skip).toBe(true)
    expect(zsets['msg:m1:events']).toBeDefined()
  })

  test('beginRun resets the events log on a fresh (non-terminal) run', async () => {
    fakeRedis['msg:m2:meta'] = { conversationId: 's', status: 'queued' }
    zsets['msg:m2:events'] = [{ score: 1, member: '{"seq":1}' }]
    const { skip } = await beginRun({ messageId: 'm2', ttlMs: 300000 })
    expect(skip).toBe(false)
    expect(zsets['msg:m2:events']).toBeUndefined()
  })

  test('beginRun proceeds when there is no meta yet', async () => {
    const { skip } = await beginRun({ messageId: 'm3', ttlMs: 300000 })
    expect(skip).toBe(false)
  })

  test('setMeta merges fields into the meta hash', async () => {
    fakeRedis['msg:m4:meta'] = { conversationId: 's', status: 'queued' }
    await setMeta({ messageId: 'm4', ttlMs: 300000, fields: { status: 'done', finishedAt: 123 } })
    expect(fakeRedis['msg:m4:meta']).toMatchObject({ conversationId: 's', status: 'done', finishedAt: 123 })
  })
})
