import * as cheerio from 'cheerio'
import { htmlToText } from 'html-to-text'
import type { ParsedDocument, ParserInput } from './parser.types'

export async function parseHtml(input: ParserInput): Promise<ParsedDocument> {
  const html = input.text ?? input.buffer?.toString('utf-8') ?? ''
  const $ = cheerio.load(html)

  // Remove scripts, styles, noscript, iframes
  $('script, style, noscript, iframe').remove()

  const title =
    $('title').first().text().trim() ||
    $('h1').first().text().trim() ||
    input.fileName ||
    input.url ||
    'HTML document'

  const text = htmlToText($.html(), {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: false } },
      { selector: 'img', format: 'skip' },
    ],
  })

  return {
    title,
    text,
    contentType: 'text/html',
    metadata: {
      parser: 'cheerio-html-to-text',
      source: input.url,
      fileName: input.fileName,
    },
  }
}
