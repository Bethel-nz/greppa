declare module 'hono' {
  interface ContextVariableMap {
    sessionId: string
    isDeployer: boolean
  }
}

export {}