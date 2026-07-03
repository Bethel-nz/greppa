export class NotFoundError extends Error {
  constructor(key: string) {
    super(`Not found: ${key}`)
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends Error {
  constructor(key: string) {
    super(`Write conflict: ${key} changed underneath this writer`)
    this.name = 'ConflictError'
  }
}
