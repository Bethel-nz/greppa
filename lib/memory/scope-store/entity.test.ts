import { describe, expect, test } from 'bun:test'
import { canonicalEntityKey, entityAliasKeys, legacyEntityKey } from './entity'

describe('legacyEntityKey', () => {
  test('is unchanged: node ids already on disk depend on it', () => {
    expect(legacyEntityKey('  Helios   Cutover ')).toBe('helios cutover')
    expect(legacyEntityKey('Acme Corp.')).toBe('acme corp.')
  })
})

describe('canonicalEntityKey', () => {
  test('folds case, accents and punctuation', () => {
    expect(canonicalEntityKey('Café  Ventures, Inc.')).toBe('cafe venture')
    expect(canonicalEntityKey('helios—cutover')).toBe('helios cutover')
  })

  test('drops a trailing legal suffix', () => {
    expect(canonicalEntityKey('Acme Corp')).toBe('acme')
    expect(canonicalEntityKey('Acme Limited')).toBe('acme')
    expect(canonicalEntityKey('Acme')).toBe('acme')
  })

  test('never strips a suffix that is the whole name', () => {
    expect(canonicalEntityKey('Ltd')).toBe('ltd')
  })

  test('drops a possessive', () => {
    expect(canonicalEntityKey("Marcy's decision")).toBe('marcy decision')
  })

  test('singularizes the final token only', () => {
    expect(canonicalEntityKey('resting cycles')).toBe('resting cycle')
    expect(canonicalEntityKey('policies')).toBe('policy')
    expect(canonicalEntityKey('batches')).toBe('batch')
  })

  test('leaves proper nouns that merely end in s alone', () => {
    expect(canonicalEntityKey('Helios')).toBe('helios')
    expect(canonicalEntityKey('Atlas')).toBe('atlas')
    expect(canonicalEntityKey('Wu')).toBe('wu')
  })

  test('is empty for input with no letters or digits', () => {
    expect(canonicalEntityKey('   —  ')).toBe('')
  })
})

describe('entityAliasKeys', () => {
  test('offers both spellings when they differ', () => {
    expect(entityAliasKeys('Acme Corp.').sort()).toEqual(['acme', 'acme corp.'])
  })

  test('collapses to one key when they agree', () => {
    expect(entityAliasKeys('helios cutover')).toEqual(['helios cutover'])
  })

  test('never yields an empty key', () => {
    expect(entityAliasKeys('  ')).toEqual([])
  })
})
