/**
 * Entity keys.
 *
 * A node id is derived from the *legacy* key so ids already written into
 * memory_edges stay valid forever. Every other spelling of the same name
 * reaches that node through memory_node_aliases, never by changing the id.
 */

const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'ltd', 'limited', 'corp', 'corporation',
  'co', 'company', 'plc', 'gmbh', 'ag', 'sa', 'bv', 'nv', 'pty', 'oy', 'ab',
])

/** The original normalization. Node ids are derived from this and cannot change. */
export function legacyEntityKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

/**
 * Singularize a trailing token. Deliberately conservative: entity names are
 * mostly proper nouns, and wrongly stripping one ("Helios" -> "Helio") merges
 * distinct entities, which is worse than missing a plural.
 */
function singularize(word: string): string {
  if (word.length <= 4) return word
  if (/(ss|us|is|os|as)$/.test(word)) return word
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (/(ches|shes|xes|zes|ses)$/.test(word)) return word.slice(0, -2)
  if (word.endsWith('s')) return word.slice(0, -1)
  return word
}

/**
 * A looser key that folds the differences that never distinguish two entities:
 * case, accents, punctuation, possessives, a trailing legal suffix, and a
 * plural on the final token.
 */
export function canonicalEntityKey(value: string): string {
  const folded = value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase()
    .replace(/['’]s\b/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
  if (!folded) return ''

  const tokens = folded.split(' ')
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop()

  const last = tokens[tokens.length - 1]
  if (last) tokens[tokens.length - 1] = singularize(last)
  return tokens.join(' ')
}

/** Every key that should resolve to this label's node. */
export function entityAliasKeys(label: string): string[] {
  const keys = new Set<string>()
  for (const key of [legacyEntityKey(label), canonicalEntityKey(label)]) {
    if (key) keys.add(key)
  }
  return [...keys]
}
