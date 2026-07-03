import { and, eq } from 'drizzle-orm'
import { drizzle, schema } from '../db'

/** Object key for a scope's Memvid file. The storage layer knows nothing about
 * users or workspaces; ownership lives in the scopes/scope_members tables. */
export function scopeObjectKey(scopeId: string): string {
  return `scopes/${scopeId}/memory.mv2`
}

/** Thrown when a user may not access the requested scope. Routes map this to 403. */
export class ScopeAccessError extends Error {
  constructor(message = 'You do not have access to this memory scope') {
    super(message)
    this.name = 'ScopeAccessError'
  }
}

const PERSONAL_SCOPE_NAME = 'personal'

/**
 * Resolve the caller's personal scope, creating it on first use. Idempotent
 * under concurrent first-writes via the (owner_user_id, name) unique index.
 */
export async function getOrCreatePersonalScope(userId: string): Promise<string> {
  const existing = await drizzle.query.scopes.findFirst({
    where: (s, { and: a, eq: e }) => a(e(s.ownerUserId, userId), e(s.name, PERSONAL_SCOPE_NAME)),
  })
  if (existing) return existing.id

  const id = crypto.randomUUID()
  await drizzle
    .insert(schema.scopes)
    .values({ id, kind: 'personal', name: PERSONAL_SCOPE_NAME, ownerUserId: userId })
    .onConflictDoNothing()

  const row = await drizzle.query.scopes.findFirst({
    where: (s, { and: a, eq: e }) => a(e(s.ownerUserId, userId), e(s.name, PERSONAL_SCOPE_NAME)),
  })
  if (!row) throw new Error('[scope] failed to resolve personal scope after insert')
  return row.id
}

/** Authorize access to a scope: the owner, or a member row. */
export async function assertScopeAccess(userId: string, scopeId: string): Promise<void> {
  const scope = await drizzle.query.scopes.findFirst({
    where: (s, { eq: e }) => e(s.id, scopeId),
  })
  if (!scope) throw new ScopeAccessError('Scope not found')
  if (scope.ownerUserId === userId) return

  const member = await drizzle
    .select({ id: schema.scopeMembers.id })
    .from(schema.scopeMembers)
    .where(and(eq(schema.scopeMembers.scopeId, scopeId), eq(schema.scopeMembers.userId, userId)))
    .limit(1)

  if (member.length === 0) throw new ScopeAccessError()
}
