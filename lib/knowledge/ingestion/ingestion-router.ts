export type IngestionStrategy =
  | 'custom-text'
  | 'custom-html'
  | 'native-file'
  | 'unsupported'

export function resolveIngestionStrategy(contentType: string): IngestionStrategy {
  if (contentType === 'text/plain') return 'custom-text'
  if (contentType === 'text/markdown') return 'custom-text'
  if (contentType === 'text/html') return 'custom-html'

  if (contentType === 'application/pdf') return 'native-file'
  if (contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return 'native-file'
  }

  if (contentType.startsWith('image/')) return 'native-file'
  if (contentType.startsWith('audio/')) return 'native-file'
  if (contentType.startsWith('video/')) return 'native-file'

  return 'unsupported'
}
