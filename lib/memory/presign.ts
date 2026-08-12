import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { r2, R2_BUCKET } from './r2'
import { getStorage } from '~/lib/storage'

const UPLOAD_EXPIRY_SECONDS = 300

/**
 * S3-specific: browser-direct upload needs a signed URL, which the generic
 * StorageBackend has no equivalent for. A non-S3 driver has to upload through
 * the server instead.
 */
export async function generatePresignedUploadUrl(
  key: string,
  contentType: string = 'application/octet-stream',
  expirySeconds: number = UPLOAD_EXPIRY_SECONDS,
): Promise<{ uploadUrl: string; key: string; expiresIn: number }> {
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentType: contentType,
  })

  const uploadUrl = await getSignedUrl(r2, command, {
    expiresIn: expirySeconds,
  })

  return { uploadUrl, key, expiresIn: expirySeconds }
}

export async function headUploadedSize(key: string): Promise<number | null> {
  const meta = await getStorage().head(key)
  return meta?.size ?? null
}

export async function deleteUpload(key: string): Promise<void> {
  await getStorage().delete(key)
}

export function buildUploadKey(
  orgId: string,
  userId: string,
  filename: string,
): string {
  const safeName = filename.replace(/[^a-zA-Z0-9.-]/g, '_')
  const uuid = crypto.randomUUID()
  return `uploads/${orgId}/${userId}/${uuid}-${safeName}`
}
