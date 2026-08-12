import type { Context } from 'hono'
import { defineErrorCatalog, EvlogError, parseError } from 'evlog'

const detailKey = Symbol.for('greppa.errorDetail')

export function withDetail<E extends EvlogError>(err: E, detail: Record<string, unknown>): E {
  return Object.assign(err, { [detailKey]: detail })
}

function detailOf(err: EvlogError): Record<string, unknown> {
  return (err as EvlogError & { [detailKey]?: Record<string, unknown> })[detailKey] ?? {}
}

export function jsonError(c: Context, err: unknown) {
  if (!(err instanceof EvlogError)) return
  const parsed = parseError(err)
  return c.json(
    {
      error: parsed.message,
      ...(parsed.code ? { code: parsed.code } : {}),
      ...(parsed.why ? { why: parsed.why } : {}),
      ...(parsed.fix ? { fix: parsed.fix } : {}),
      ...(parsed.link ? { link: parsed.link } : {}),
      ...detailOf(err),
    },
    parsed.status as 400,
  )
}

export const authErrors = defineErrorCatalog('auth', {
  REQUIRED: {
    status: 401,
    message: 'Authentication required',
    why: 'The request carried no session cookie and no API key.',
    fix: 'Send an x-api-key header, or sign in and send the session cookie.',
  },
  FORBIDDEN: {
    status: 403,
    message: 'Forbidden',
    why: 'The caller is authenticated but is not a member of the target organization.',
    fix: 'Ask an org admin to add you, or call with an org you belong to.',
  },
  MEMBERSHIP_UNVERIFIABLE: {
    status: 403,
    message: 'Membership verification failed',
    why: 'The membership lookup did not complete, so access could not be granted.',
    fix: 'Retry shortly. If it persists, the auth database is unreachable.',
  },
  ANONYMOUS_LIMIT: {
    status: 429,
    message: 'Anonymous message limit reached',
    why: 'Anonymous sessions are capped to a fixed number of messages.',
    fix: 'Sign in to continue the conversation.',
  },
})

export const requestErrors = defineErrorCatalog('request', {
  ORG_ID_REQUIRED: {
    status: 400,
    message: 'orgId query param required',
    why: 'This route reads organization-scoped memory and cannot infer the org.',
    fix: 'Add ?orgId=<your org id> to the request.',
  },
  SCOPE_AMBIGUOUS: {
    status: 400,
    message: 'Choose either orgId or workspaceId',
    why: 'Organization memory and workspace memory are separate scopes; a record belongs to one.',
    fix: 'Send orgId for shared org knowledge, or workspaceId for workspace knowledge, not both.',
  },
  SCOPE_CONTEXT_MISSING: {
    status: 400,
    message: 'Missing org or user context',
    why: 'The route resolved neither an orgId path param nor an authenticated user.',
    fix: 'Call /orgs/{orgId}/... with a valid org id while authenticated.',
  },
  PLACEMENT_REQUIRED: {
    status: 400,
    message: 'Send workspaceId, folderId, or both',
    why: 'A move with neither placement would leave every document exactly where it is.',
    fix: 'Send the placement you want, or null to unplace the documents.',
  },
  FIELD_REQUIRED: {
    status: 400,
    message: ({ field }: { field: string }) => `${field} is required`,
  },
  NOT_MULTIPART: {
    status: 400,
    message: 'Expected multipart/form-data',
    why: 'File upload reads the body as a multipart form.',
    fix: 'Send the file as multipart/form-data with a "file" field.',
  },
})

export const knowledgeErrors = defineErrorCatalog('knowledge', {
  NOT_FOUND: {
    status: 404,
    message: 'Not found',
    why: 'No document with that id exists in the requested scope.',
    fix: 'List documents for the org to get a valid documentId.',
  },
  UPLOAD_MISSING: {
    status: 404,
    message: 'No uploaded object at that key',
    why: 'Ingest was called for a key that holds no object in storage.',
    fix: 'Call POST /knowledge/presign, PUT the file to the returned URL, then ingest.',
  },
  UNPARSEABLE: {
    status: 415,
    message: ({ reason }: { reason: string }) => reason,
    why: 'The uploaded file could not be parsed into text.',
    fix: 'Upload a text, markdown, PDF, or office document.',
  },
  TOO_LARGE: {
    status: 413,
    message: ({ size, limit }: { size?: string; limit: string }) =>
      size
        ? `Uploaded file is ${size}, over the ${limit} upload limit`
        : `File exceeds the ${limit} upload limit`,
    fix: 'Split the document or compress it before uploading.',
  },
})
