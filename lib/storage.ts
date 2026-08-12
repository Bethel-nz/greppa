import type { StorageBackend } from '~/utils/checkpoint/storage'
import { MemoryStorage } from '~/utils/checkpoint/storage'
import { R2Storage } from '~/utils/r2'

export type StorageFactory = () => StorageBackend

const registry = new Map<string, StorageFactory>([
  ['r2', () => R2Storage.fromEnv()],
  ['memory', () => new MemoryStorage()],
])

let cached: StorageBackend | null = null
let injected: StorageBackend | null = null

/**
 * Adds a driver selectable through STORAGE_DRIVER. Register at boot, before
 * anything touches storage. A backend needing async setup should be built by
 * the caller and handed to `setStorage` instead.
 */
export function registerStorageDriver(name: string, factory: StorageFactory): void {
  const key = name.trim().toLowerCase()
  registry.set(key, factory)
  if (key === currentDriver()) cached = null
}

/**
 * Uses this backend for everything, ignoring STORAGE_DRIVER. Pass null to fall
 * back to the configured driver. Intended for embedders and for tests.
 */
export function setStorage(backend: StorageBackend | null): void {
  injected = backend
  cached = null
}

function currentDriver(): string {
  return (process.env.STORAGE_DRIVER ?? 'r2').trim().toLowerCase()
}

export function getStorage(): StorageBackend {
  if (injected) return injected
  if (cached) return cached
  const driver = currentDriver()
  const factory = registry.get(driver)
  if (!factory) {
    throw new Error(
      `[storage] unknown STORAGE_DRIVER "${driver}"; known drivers: ${[...registry.keys()].sort().join(', ')}`,
    )
  }
  cached = factory()
  return cached
}

export function _resetStorageForTests(): void {
  cached = null
  injected = null
}
