export const INLINE_UPLOAD_LIMIT_BYTES = 2 * 1024 * 1024

const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export function maxUploadBytes(): number {
  const raw = process.env.MAX_UPLOAD_BYTES
  if (!raw) return DEFAULT_MAX_UPLOAD_BYTES
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_UPLOAD_BYTES
  return Math.floor(parsed)
}

export function formatBytes(bytes: number): string {
  const mib = bytes / 1024 / 1024
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`
}
