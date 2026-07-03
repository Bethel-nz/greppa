import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { withR2Retry } from './retry'

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY
export const R2_BUCKET = process.env.R2_BUCKET ?? 'greppa-memory'
export const R2_MEMORY_KEY = process.env.R2_MEMORY_KEY ?? 'greppa/prod/app.mv2'

const R2_CONFIGURED = Boolean(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY)

if (!R2_CONFIGURED) {
  console.warn('[R2] credentials incomplete — uploads/downloads will fail')
}

/**
 * A genuine "object not found" is the ONLY error we may interpret as absence.
 * Anything else (403, throttling, network, missing creds) must propagate so the
 * caller never mistakes a recoverable failure for "no remote memory" and clobbers
 * the shared .mv2 with a fresh empty file.
 */
function isNotFoundError(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  return (
    e?.name === 'NotFound' ||
    e?.name === 'NoSuchKey' ||
    e?.$metadata?.httpStatusCode === 404
  )
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

export async function r2ObjectExists(key: string): Promise<boolean> {
  if (!R2_CONFIGURED) {
    throw new Error('[R2] credentials incomplete — refusing to probe object existence')
  }
  return withR2Retry(async () => {
    try {
      await r2.send(
        new HeadObjectCommand({
          Bucket: R2_BUCKET,
          Key: key,
        }),
      )
      return true
    } catch (err) {
      if (isNotFoundError(err)) return false
      throw err
    }
  })
}

export async function downloadMemoryFromR2(
  localPath: string,
  key: string = R2_MEMORY_KEY,
): Promise<boolean> {
  return withR2Retry(async () => {
    await mkdir(dirname(localPath), { recursive: true })

    const exists = await r2ObjectExists(key)
    if (!exists) return false

    const result = await r2.send(
      new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
      }),
    )

    if (!result.Body) {
      throw new Error('R2 memory object has no body')
    }

    await pipeline(result.Body as NodeJS.ReadableStream, createWriteStream(localPath))
    return true
  })
}

export async function uploadMemoryToR2(
  localPath: string,
  key: string = R2_MEMORY_KEY,
): Promise<void> {
  return withR2Retry(async () => {
    const body = await readFile(localPath)

    await r2.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: body,
        ContentType: 'application/octet-stream',
      }),
    )
  })
}

export async function uploadMemorySnapshot(
  localPath: string,
  key: string,
): Promise<void> {
  await uploadMemoryToR2(localPath, key)
}

export type R2SnapshotEntry = { key: string; lastModified?: Date }

export async function listR2Snapshots(prefix: string): Promise<R2SnapshotEntry[]> {
  return withR2Retry(async () => {
    const entries: R2SnapshotEntry[] = []
    let continuationToken: string | undefined

    do {
      const result = await r2.send(
        new ListObjectsV2Command({
          Bucket: R2_BUCKET,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      )

      for (const obj of result.Contents ?? []) {
        if (obj.Key) entries.push({ key: obj.Key, lastModified: obj.LastModified })
      }
      continuationToken = result.NextContinuationToken
    } while (continuationToken)

    return entries
  })
}

export async function deleteR2Object(key: string): Promise<void> {
  return withR2Retry(async () => {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }))
  })
}

export async function countR2Snapshots(prefix: string = 'greppa/prod/'): Promise<number> {
  return withR2Retry(async () => {
    let count = 0
    let continuationToken: string | undefined

    do {
      const result = await r2.send(
        new ListObjectsV2Command({
          Bucket: R2_BUCKET,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      )

      count += result.Contents?.length ?? 0
      continuationToken = result.NextContinuationToken
    } while (continuationToken)

    return count
  })
}
