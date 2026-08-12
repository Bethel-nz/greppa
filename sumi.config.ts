import { defineConfig } from '@bethel-nz/sumi';
  import type { Context } from 'hono';
  import { fileURLToPath } from 'url';
  import path from 'path';
  import { jsonError } from './lib/errors';

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const PUBLIC_DIR = path.join(__dirname, 'public'); 

  export default defineConfig({
    port: 3009,
    logger: true,
    basePath: '/api/v1',
    routesDir: './routes',
    middlewareDir: './middleware',

    hooks: {
      onError: (error: Error, c: Context) => jsonError(c, error),
    },

    // Static files are mounted under the app's basePath automatically by Sumi,
    // so '/public/*' becomes '/api/v1/public/*'
    static: [
      { path: '/public/*', root: PUBLIC_DIR },
    ],


    openapi: {
      documentation: {
        info: {
          title: 'Greppa API',
          version: '1.0.0',
          description: 'A knowledge API. Ingest articles and documents, then interact with them via streaming AI chat.',
        },
        servers: [
          { url: 'http://localhost:3009', description: 'Local' },
        ],
      }
    },

    docs: {
      path: '/docs',
      pageTitle: 'Greppa API Docs',
      favicon: '/favicon.ico?v=2',
      theme: 'saturn',
      darkMode: true,
      defaultOpenAllTags: true,
      sources: [
        { url: '/api/v1/openapi.json', title: 'Greppa API' },
        { url: '/api/v1/auth/open-api/generate-schema', title: 'Auth' },
      ],
    }
  });