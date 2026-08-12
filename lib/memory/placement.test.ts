import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { placementFromQuery } from './placement'

const scopeFor = async (url: string) => {
  const app = new Hono()
  let scope: unknown
  app.get('/', (c) => {
    scope = placementFromQuery(c)
    return c.json({})
  })
  await app.request(url)
  return scope
}

describe('placementFromQuery', () => {
  test('an absent param is no constraint, not a null placement', async () => {
    expect(await scopeFor('/')).toEqual({ workspaceId: undefined, folderId: undefined })
  })

  test('a present param names the placement', async () => {
    expect(await scopeFor('/?workspaceId=ws-acme&folderId=folder-onboarding')).toEqual({
      workspaceId: 'ws-acme',
      folderId: 'folder-onboarding',
    })
  })

  test('an empty param asks for records with nothing in that slot', async () => {
    expect(await scopeFor('/?workspaceId=ws-acme&folderId=')).toEqual({
      workspaceId: 'ws-acme',
      folderId: null,
    })
  })

  test('the two hierarchies are read independently', async () => {
    expect(await scopeFor('/?folderId=folder-onboarding')).toEqual({
      workspaceId: undefined,
      folderId: 'folder-onboarding',
    })
    expect(await scopeFor('/?workspaceId=')).toEqual({ workspaceId: null, folderId: undefined })
  })
})
