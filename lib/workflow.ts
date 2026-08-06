import { Client } from '@upstash/workflow'

let _client: Client | null = null

export function getWorkflowClient(): Client {
  if (!_client) {
    if (!process.env.QSTASH_TOKEN) {
      throw new Error('QSTASH_TOKEN is required for Upstash Workflow')
    }
    _client = new Client({
      token: process.env.QSTASH_TOKEN,
      baseUrl: process.env.QSTASH_URL,
    })
  }
  return _client
}

export async function triggerChatWorkflow(payload: {
  conversationId: string
  messageId: string
  userMessageId: string
  message: string
  model: string
  context?: { selection?: string; source?: string; title?: string; surrounding?: string }
  userId?: string | null
  orgId?: string | null
  workspaceId?: string
}): Promise<void> {
  const base = process.env.GREPPA_PUBLIC_URL
  if (!base) throw new Error('GREPPA_PUBLIC_URL is required (full URL of this server)')
  await getWorkflowClient().trigger({
    url: `${base.replace(/\/$/, '')}/api/v1/workflows/chat`,
    body: payload,
  })
}

export async function triggerIngestWorkflow(payload: {
  jobId: string
  orgId: string
  userId: string
  documentId: string
  r2Key: string
  contentType: string
  fileName: string
  title: string
}): Promise<void> {
  const base = process.env.GREPPA_PUBLIC_URL
  if (!base) throw new Error('GREPPA_PUBLIC_URL is required (full URL of this server)')
  await getWorkflowClient().trigger({
    url: `${base.replace(/\/$/, '')}/api/v1/workflows/ingest`,
    body: payload,
  })
}
