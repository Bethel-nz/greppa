import PQueue from 'p-queue'

const memoryWriteQueue = new PQueue({
  concurrency: 1,
})

export function enqueueMemoryWrite<T>(job: () => Promise<T>): Promise<T> {
  return memoryWriteQueue.add(job) as Promise<T>
}
