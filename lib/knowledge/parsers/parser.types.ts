export type ParsedDocument = {
  title?: string
  text: string
  contentType: string
  metadata?: Record<string, unknown>
}

export type ParserInput = {
  buffer?: Buffer
  text?: string
  url?: string
  fileName?: string
  contentType: string
}
