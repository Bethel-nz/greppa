import { createRoute } from "@bethel-nz/sumi/router";

export default createRoute({
  get: {
    handler: (c) =>
      c.json({
        name: "greppa api",
        version: "1.0.0",
        description: "Multi-tenant AI memory platform. Ingest documents, search with ACL enforcement, and chat with your knowledge base.",
        endpoints: {
          "GET    /me": "Get current authenticated user",
          "GET    /me/api-keys": "List your API keys",
          "POST   /me/api-keys": "Create an API key (plaintext returned once)",
          "DELETE /me/api-keys/:keyId": "Revoke an API key",

          "POST   /session": "Mint a new conversation session",
          "DELETE /session": "Revoke current session conversation",
          
          "POST   /chat": "Enqueue a chat generation",
          "GET    /chat/stream": "Subscribe to message SSE stream",
          "GET    /chat/history": "Load conversation history",
          "DELETE /chat/history": "Wipe conversation history",
          
          "GET    /knowledge?orgId=:orgId": "List org articles",
          "POST   /knowledge": "Ingest a text article (JSON)",
          "POST   /knowledge/presign": "Get presigned URL for file upload",
          "POST   /knowledge/ingest": "Process uploaded file into knowledge base",
          "GET    /knowledge/:documentId": "Get article metadata",
          "PATCH  /knowledge/:documentId": "Update an article",
          "DELETE /knowledge/:documentId": "Delete an article",
          
          "GET    /orgs/:orgId/memory": "List org memory documents",
          "POST   /orgs/:orgId/memory": "Add memory to org",
          "POST   /orgs/:orgId/memory/search": "Search org memory (ACL enforced)",
          "POST   /orgs/:orgId/memory/ask": "Ask org memory (ACL enforced)",
          
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
