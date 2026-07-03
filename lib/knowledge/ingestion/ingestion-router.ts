export type IngestionStrategy =
  | 'custom-text'
  | 'custom-html'
  | 'memvid-native-file'
  | 'unsupported'

export function resolveIngestionStrategy(contentType: string): IngestionStrategy {
  if (contentType === 'text/plain') return 'custom-text'
  if (contentType === 'text/markdown') return 'custom-text'
  if (contentType === 'text/html') return 'custom-html'

  if (contentType === 'application/pdf') return 'memvid-native-file'
  if (contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return 'memvid-native-file'
  }

  if (contentType.startsWith('image/')) return 'memvid-native-file'
  if (contentType.startsWith('audio/')) return 'memvid-native-file'
  if (contentType.startsWith('video/')) return 'memvid-native-file'

  return 'unsupported'
}
