import { z } from 'zod'
import type { Context } from 'hono'
import type { MemoryScope } from './scope-store/store'

const describe = (level: string) =>
  `${level} to read from. Omit for no constraint, send an empty value for records with no ${level.toLowerCase()}.`

export const placementQuery = z.object({
  workspaceId: z.string().optional().describe(describe('Workspace')),
  folderId: z.string().optional().describe(describe('Folder')),
})

export const placementBody = {
  workspaceId: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('Workspace to read from. Omit for no constraint, null for records with no workspace.'),
  folderId: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('Folder to read from. Omit for no constraint, null for records with no folder.'),
}

const fromParam = (raw: string | undefined): string | null | undefined =>
  raw === undefined ? undefined : raw === '' ? null : raw

export function placementFromQuery(c: Context): MemoryScope {
  return {
    workspaceId: fromParam(c.req.query('workspaceId')),
    folderId: fromParam(c.req.query('folderId')),
  }
}
