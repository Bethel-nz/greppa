import { getDrizzle } from '../db'

export type GreppaAclContext = {
  tenantId: string
  subjectId: string
  roles: string[]
  groupIds: string[]
}

export class MembershipError extends Error {
  constructor(message = 'User does not belong to this organization') {
    super(message)
    this.name = 'MembershipError'
  }
}

function normalizeAclStrings(values: string[]): string[] {
  return values.map((v) => v.trim().toLowerCase()).filter(Boolean)
}

export async function getAclContext({
  userId,
  orgId,
}: {
  userId: string
  orgId: string
}): Promise<GreppaAclContext> {
  const db = getDrizzle()
  const membership = await db.query.memberships.findFirst({
    where: (m, { and, eq }) => and(eq(m.userId, userId), eq(m.orgId, orgId)),
  })

  if (!membership) {
    throw new MembershipError()
  }

  return {
    tenantId: orgId.trim().toLowerCase(),
    subjectId: userId.trim().toLowerCase(),
    roles: normalizeAclStrings([membership.role]),
    groupIds: normalizeAclStrings(membership.groupIds ?? []),
  }
}
