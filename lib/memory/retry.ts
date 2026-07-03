import pRetry from 'p-retry'

export function withR2Retry<T>(fn: () => Promise<T>): Promise<T> {
  return pRetry(fn, {
    retries: 3,
    factor: 2,
    minTimeout: 500,
    maxTimeout: 5000,
  })
}
