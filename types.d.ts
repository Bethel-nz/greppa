declare module 'hono' {
  interface ContextVariableMap {
    sessionId: string
    conversationId: string
    orgId: string | null
    isAnonymous: boolean
    userId: string | null
    authUser: {
      id: string
      email: string
      name?: string | null
      emailVerified: boolean
      image?: string | null
      createdAt: Date
      updatedAt: Date
    } | null
    authSession: {
      id: string
      userId: string
      expiresAt: Date
      createdAt: Date
      updatedAt: Date
      token: string
      ipAddress?: string | null
      userAgent?: string | null
    } | null
  }
}

export {}
