import { createHash } from 'node:crypto'

export function contentDocumentId(userId: string, text: string): string {
  const digest = createHash('sha256').update(userId).update('\0').update(text).digest('hex')
  return `doc_${digest.slice(0, 32)}`
}

export function scopedDocumentId(
  userId: string,
  workspaceId: string | undefined,
  ...parts: string[]
): string {
  return contentDocumentId(userId, [workspaceId ?? 'personal', ...parts].join('\n'))
}
