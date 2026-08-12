import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { ConflictError } from './checkpoint/errors'
import type { ObjectMeta, StorageBackend } from './checkpoint/storage'

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404
}

function isPreconditionFailed(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === 'PreconditionFailed' || e?.$metadata?.httpStatusCode === 412
}

function isTransient(err: unknown): boolean {
  if (isPreconditionFailed(err) || isNotFound(err)) return false
  const e = err as { $metadata?: { httpStatusCode?: number } }
  const status = e?.$metadata?.httpStatusCode
  if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) return false
  return true
}

const TRANSFER_ATTEMPTS = 3

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt < TRANSFER_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (err) {
      last = err
      if (!isTransient(err) || attempt + 1 >= TRANSFER_ATTEMPTS) throw err
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt))
    }
  }
  throw last
}

export type R2StorageConfig = {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

export class R2Storage implements StorageBackend {
  private readonly client: S3Client
  private readonly bucket: string

  constructor(cfg: R2StorageConfig) {
    this.bucket = cfg.bucket
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    })
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): R2Storage {
    const accountId = env.R2_ACCOUNT_ID
    const accessKeyId = env.R2_ACCESS_KEY_ID
    const secretAccessKey = env.R2_SECRET_ACCESS_KEY
    const bucket = env.R2_BUCKET ?? 'greppa-memory'
    if (!accountId || !accessKeyId || !secretAccessKey) {
      throw new Error('[r2] R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required')
    }
    return new R2Storage({ accountId, accessKeyId, secretAccessKey, bucket })
  }

  async head(key: string): Promise<ObjectMeta | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return { key, etag: r.ETag ?? '', size: r.ContentLength ?? 0 }
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async get(key: string): Promise<{ body: Uint8Array; etag: string } | null> {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      if (!r.Body) throw new Error(`[r2] object ${key} has no body`)
      const body = await r.Body.transformToByteArray()
      return { body, etag: r.ETag ?? '' }
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async getToFile(key: string, localPath: string): Promise<{ etag: string } | null> {
    try {
      return await withRetry(async () => {
        const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
        if (!r.Body) throw new Error(`[r2] object ${key} has no body`)
        await pipeline(r.Body as NodeJS.ReadableStream, createWriteStream(localPath))
        return { etag: r.ETag ?? '' }
      })
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async putIfMatch(key: string, body: Uint8Array, etag: string | null): Promise<string> {
    try {
      const r = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: 'application/octet-stream',
          ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
        }),
      )
      return r.ETag ?? ''
    } catch (err) {
      if (isPreconditionFailed(err)) throw new ConflictError(key)
      throw err
    }
  }

  async putFileIfMatch(key: string, localPath: string, etag: string | null): Promise<string> {
    try {
      return await withRetry(async () => {
        const { size } = await stat(localPath)
        const r = await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: createReadStream(localPath),
            ContentLength: size,
            ContentType: 'application/octet-stream',
            ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
          }),
        )
        return r.ETag ?? ''
      })
    } catch (err) {
      if (isPreconditionFailed(err)) throw new ConflictError(key)
      throw err
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  async list(prefix: string): Promise<ObjectMeta[]> {
    const out: ObjectMeta[] = []
    let token: string | undefined
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      )
      for (const o of r.Contents ?? []) {
        if (o.Key) out.push({ key: o.Key, etag: o.ETag ?? '', size: o.Size ?? 0 })
      }
      token = r.NextContinuationToken
    } while (token)
    return out
  }
}
