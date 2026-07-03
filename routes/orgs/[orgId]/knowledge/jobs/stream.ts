import { z } from 'zod'
import { createRoute } from '@bethel-nz/sumi/router'
import { drizzle, schema } from '~/lib/db'
import { getAclContext } from '~/lib/memory/acl'
import { eq, and, gt } from 'drizzle-orm'

const querySchema = z.object({
  jobId: z.string().min(1).describe('Ingestion job ID to stream events for'),
})

export default createRoute({
  get: {
    schema: { query: querySchema },
    middleware: ['user-auth'],
    stream: async (stream, c) => {
      const orgId = c.req.param('orgId')
      const userId = c.get('userId')
      const jobId = c.req.query('jobId')

      if (!jobId) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ code: 'bad_request', reason: 'jobId query parameter required' }),
        })
        return
      }

      if (!userId || !orgId) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ code: 'unauthorized', reason: 'missing user or org context' }),
        })
        return
      }

      // Verify user belongs to org
      try {
        await getAclContext({ userId, orgId })
      } catch {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ code: 'forbidden', reason: 'user does not belong to this organization' }),
        })
        return
      }

      // Verify job exists and belongs to org
      const job = await drizzle.query.ingestionJobs.findFirst({
        where: (j, { and, eq }) => and(eq(j.id, jobId), eq(j.orgId, orgId)),
      })

      if (!job) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ code: 'not_found', reason: 'job not found' }),
        })
        return
      }

      // Send all existing events first
      const existingEvents = await drizzle
        .select()
        .from(schema.ingestionJobEvents)
        .where(
          and(
            eq(schema.ingestionJobEvents.jobId, jobId),
            eq(schema.ingestionJobEvents.orgId, orgId),
          ),
        )
        .orderBy(schema.ingestionJobEvents.createdAt)

      let lastEventTime = new Date(0)
      for (const event of existingEvents) {
        await stream.writeSSE({
          id: event.id,
          event: event.type,
          data: JSON.stringify({
            type: event.type,
            message: event.message,
            progress: event.progress,
            payload: event.payload,
            createdAt: event.createdAt,
          }),
        })
        lastEventTime = event.createdAt
      }

      // If already terminal, close immediately
      if (job.status === 'indexed' || job.status === 'failed') {
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({ status: job.status, progress: job.progress }),
        })
        return
      }

      // Poll for new events
      const pollIntervalMs = 1000
      const maxWaitMs = 10 * 60 * 1000 // 10 minutes max
      const startTime = Date.now()
      let isTerminal = false

      while (!isTerminal && Date.now() - startTime < maxWaitMs) {
        await new Promise((r) => setTimeout(r, pollIntervalMs))

        const newEvents = await drizzle
          .select()
          .from(schema.ingestionJobEvents)
          .where(
            and(
              eq(schema.ingestionJobEvents.jobId, jobId),
              eq(schema.ingestionJobEvents.orgId, orgId),
              gt(schema.ingestionJobEvents.createdAt, lastEventTime),
            ),
          )
          .orderBy(schema.ingestionJobEvents.createdAt)

        for (const event of newEvents) {
          await stream.writeSSE({
            id: event.id,
            event: event.type,
            data: JSON.stringify({
              type: event.type,
              message: event.message,
              progress: event.progress,
              payload: event.payload,
              createdAt: event.createdAt,
            }),
          })
          lastEventTime = event.createdAt
        }

        // Check if terminal
        const currentJob = await drizzle.query.ingestionJobs.findFirst({
          where: (j, { eq }) => eq(j.id, jobId),
        })

        if (currentJob?.status === 'indexed' || currentJob?.status === 'failed') {
          isTerminal = true
          await stream.writeSSE({
            event: 'done',
            data: JSON.stringify({
              status: currentJob.status,
              progress: currentJob.progress,
            }),
          })
        }
      }

      // Timeout fallback
      if (!isTerminal) {
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({ status: 'timeout', reason: 'Stream timed out before job completed' }),
        })
      }
    },
    openapi: {
      summary: 'Stream ingestion job events',
      description:
        'SSE stream of ingestion progress. Sends all existing events immediately, then polls ingestion_job_events every second for new events. Emits a final done event when the job completes, fails, or times out.',
      tags: ['knowledge'],
      responses: {
        200: { description: 'SSE stream (text/event-stream)' },
        401: { description: 'Authentication required' },
        403: { description: 'User does not belong to organization' },
        404: { description: 'Job not found' },
      },
    },
  },
})
