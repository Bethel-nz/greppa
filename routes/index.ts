import { createRoute } from "@bethel-nz/sumi/router";

export default createRoute({
  get: {
    handler: (c) =>
      c.json({
        name: "greppa api",
        version: "1.0.0",
        endpoints: {
          "GET    /knowledge":            "List all articles",
          "POST   /knowledge":            "Ingest a text article",
          "PUT    /knowledge":            "Ingest a file (multipart)",
          "GET    /knowledge/:frameId":   "Get article metadata",
          "PATCH  /knowledge/:frameId":   "Update an article",
          "DELETE /knowledge/:frameId":   "Delete an article",
          "POST   /chat":                 "Stream chat about your articles (SSE)",
          "GET    /stats":                "Knowledge base stats",
        },
      }),
  },
});
