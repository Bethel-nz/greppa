// Extends Hono's context variable map so c.set() / c.get() are fully typed
// across all routes and middleware without needing type assertions.
declare module 'hono' {
  interface ContextVariableMap {
    userId: string;
    userLastSeen: Date | null;
  }
}
