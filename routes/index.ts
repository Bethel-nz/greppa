import { createRoute } from "@bethel-nz/sumi/router";

export default createRoute({
  get: {
    handler: (c) =>
      c.json({
        name: "greppa api",
        version: "1.0.0",
        description: "Multi-tenant AI memory platform. Ingest documents, search with ACL enforcement, and chat with your knowledge base.",
        endpoints: {
          // Auth
          "GET    /me": "Get current authenticated user",
          "GET    /api/v1/auth/*": "Better Auth endpoints (login, register, OAuth, api-key)",
          "GET    /me/api-keys": "List your API keys",
          "POST   /me/api-keys": "Create an API key (plaintext returned once)",
          "DELETE /me/api-keys/:keyId": "Revoke an API key",

          // Session
          "POST   /session": "Mint a new conversation session",
          "DELETE /session": "Revoke current session conversation",
          
          // Chat
          "POST   /chat": "Enqueue a chat generation",
          "GET    /chat/stream": "Subscribe to message SSE stream",
          "GET    /chat/history": "Load conversation history",
          "DELETE /chat/history": "Wipe conversation history",
          
          // Knowledge (Multi-tenant)
          "GET    /knowledge?orgId=:orgId": "List org articles",
          "POST   /knowledge": "Ingest a text article (JSON)",
          "POST   /knowledge/presign": "Get presigned URL for file upload",
          "POST   /knowledge/ingest": "Process uploaded file into knowledge base",
          "GET    /knowledge/:frameId": "Get article metadata",
          "PATCH  /knowledge/:frameId": "Update an article",
          "DELETE /knowledge/:frameId": "Delete an article",
          
          // Org Memory
          "GET    /orgs/:orgId/memory": "List org memory documents",
          "POST   /orgs/:orgId/memory": "Add memory to org",
          "POST   /orgs/:orgId/memory/search": "Search org memory (ACL enforced)",
          "POST   /orgs/:orgId/memory/ask": "Ask org memory (ACL enforced)",
          
          // Stats
          "GET    /stats?orgId=:orgId": "Organization memory stats",
        },
      }),
    openapi: {
      summary: 'Greppa API Root',
      tags: ['info'],
      responses: {
        200: { description: 'API information and endpoint listing' }
      }
    }
  },
});
