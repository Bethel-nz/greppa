import { defineConfig } from 'drizzle-kit'

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for Drizzle config')
}

export default defineConfig({
  out: './drizzle',
  schema: './db/schema/*.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
})
