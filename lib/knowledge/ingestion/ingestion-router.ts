export type IngestionStrategy =
  | 'custom-text'
  | 'custom-html'
  | 'anydoc'
  | 'unsupported'

const ANYDOC_MIME_TYPES = new Set([
  'application/pdf',
  'text/csv',
  'application/rtf',
  'text/rtf',
  'application/epub+zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
])

const ANYDOC_EXTENSIONS = new Set([
  'doc', 'docx', 'docm', 'pdf', 'ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'ppsm',
  'pot', 'odt', 'ods', 'odp', 'rtf', 'epub', 'xls', 'xlsx', 'xlsm', 'xlsb', 'csv',
])

export function resolveIngestionStrategy(contentType: string, fileName?: string): IngestionStrategy {
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (mediaType === 'text/plain') return 'custom-text'
  if (mediaType === 'text/markdown') return 'custom-text'
  if (mediaType === 'text/html') return 'custom-html'

  if (ANYDOC_MIME_TYPES.has(mediaType)) return 'anydoc'

  const extension = fileName?.split('.').pop()?.toLowerCase()
  if (extension && ANYDOC_EXTENSIONS.has(extension)) return 'anydoc'

  return 'unsupported'
}
