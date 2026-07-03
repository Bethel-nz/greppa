import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

export type ParsedDocument = {
  title: string
  text: string
  mimeType: string
}

export async function extractTextFromFile(
  filePath: string,
  mimeType: string = 'application/octet-stream',
): Promise<ParsedDocument> {
  if (!existsSync(filePath)) {
    throw new Error('File not found')
  }

  // Plain text files
  if (mimeType.startsWith('text/') || mimeType === 'application/json') {
    const text = await readFile(filePath, 'utf-8')
    return { title: 'Document', text, mimeType }
  }

  // PDF - placeholder: for production use pdf-parse or similar
  if (mimeType === 'application/pdf') {
    // TODO: integrate pdf-parse or pdfjs-dist
    return { title: 'PDF Document', text: '[PDF parsing not yet implemented]', mimeType }
  }

  // DOCX - placeholder: for production use mammoth or similar
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    // TODO: integrate mammoth
    return { title: 'Word Document', text: '[DOCX parsing not yet implemented]', mimeType }
  }

  // Markdown
  if (mimeType === 'text/markdown' || filePath.endsWith('.md')) {
    const text = await readFile(filePath, 'utf-8')
    return { title: 'Markdown Document', text, mimeType: 'text/markdown' }
  }

  // Default: try to read as text
  try {
    const text = await readFile(filePath, 'utf-8')
    return { title: 'Document', text, mimeType }
  } catch {
    return { title: 'Binary Document', text: '[Binary file content not extractable]', mimeType }
  }
}
