import { afterEach, describe, expect, test } from 'bun:test'
import { MemoryStorage } from '~/utils/checkpoint/storage'
import { _resetStorageForTests, getStorage, registerStorageDriver, setStorage } from './storage'

const original = process.env.STORAGE_DRIVER

afterEach(() => {
  _resetStorageForTests()
  if (original === undefined) delete process.env.STORAGE_DRIVER
  else process.env.STORAGE_DRIVER = original
})

describe('storage driver selection', () => {
  test('STORAGE_DRIVER picks the backend', () => {
    process.env.STORAGE_DRIVER = 'memory'
    expect(getStorage()).toBeInstanceOf(MemoryStorage)
  })

  test('the backend is built once and reused', () => {
    process.env.STORAGE_DRIVER = 'memory'
    expect(getStorage()).toBe(getStorage())
  })

  test('an unknown driver names the ones that exist instead of failing silently', () => {
    process.env.STORAGE_DRIVER = 'ftp'
    expect(() => getStorage()).toThrow(/unknown STORAGE_DRIVER "ftp".*memory, r2/s)
  })

  test('a driver name is matched case- and whitespace-insensitively', () => {
    process.env.STORAGE_DRIVER = '  MEMORY '
    expect(getStorage()).toBeInstanceOf(MemoryStorage)
  })
})

describe('bringing your own backend', () => {
  test('a registered driver is selectable by name', () => {
    const mine = new MemoryStorage()
    registerStorageDriver('vps', () => mine)
    process.env.STORAGE_DRIVER = 'vps'

    expect(getStorage()).toBe(mine)
  })

  test('setStorage wins over STORAGE_DRIVER', () => {
    const mine = new MemoryStorage()
    process.env.STORAGE_DRIVER = 'r2'
    setStorage(mine)

    // r2 would have thrown for missing credentials; the injected one is used.
    expect(getStorage()).toBe(mine)
  })

  test('clearing the injected backend falls back to the configured driver', () => {
    process.env.STORAGE_DRIVER = 'memory'
    const mine = new MemoryStorage()
    setStorage(mine)
    expect(getStorage()).toBe(mine)

    setStorage(null)
    expect(getStorage()).not.toBe(mine)
    expect(getStorage()).toBeInstanceOf(MemoryStorage)
  })

  test('re-registering the active driver takes effect rather than serving the cache', () => {
    process.env.STORAGE_DRIVER = 'swap'
    const first = new MemoryStorage()
    registerStorageDriver('swap', () => first)
    expect(getStorage()).toBe(first)

    const second = new MemoryStorage()
    registerStorageDriver('swap', () => second)
    expect(getStorage()).toBe(second)
  })
})
