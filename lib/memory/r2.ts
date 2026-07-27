import { S3Client } from '@aws-sdk/client-s3'

/**
 * Shared S3 client for R2, used by the presign path and the ingest workflow.
 *
 * Scope memory does NOT go through here. It uses `utils/r2.ts` (`R2Storage`),
 * which implements Checkpoint's `StorageBackend` with streamed transfers and
 * conditional writes. The global-memory helpers that used to live in this file
 * belonged to the single shared `.mv2` and were removed with it.
 */
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY

export const R2_BUCKET = process.env.R2_BUCKET ?? 'greppa-memory'

if (!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY)) {
  console.warn('[R2] credentials incomplete — uploads/downloads will fail')
}

export const r2 = new S3Client({
  region: 'auto',
  endpoint: R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined,
  credentials:
    R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY
      ? {
          accessKeyId: R2_ACCESS_KEY_ID,
          secretAccessKey: R2_SECRET_ACCESS_KEY,
        }
      : undefined,
})
