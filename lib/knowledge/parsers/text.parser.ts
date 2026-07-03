import type { ParsedDocument, ParserInput } from './parser.types'

export async function parseText(input: ParserInput): Promise<ParsedDocument> {
  const text = input.text ?? input.buffer?.toString('utf-8') ?? ''
  const title = input.fileName ?? input.url ?? 'Text document'

  return {
    title,
    text,
    contentType: 'text/plain',
    metadata: {
      parser: 'text',
      source: input.url,
      fileName: input.fileName,
    },
  }
}
