export function formatPassages(passages: Array<{ title: string; text: string }>): string {
  return passages.map((p, i) => `### [${i + 1}] ${p.title}\n${p.text}`).join('\n\n')
}
