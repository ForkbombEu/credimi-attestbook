// Typed registry failures.
//
// The service layer throws these instead of generic errors so the HTTP layer
// added in a later issue can map codes to stable statuses without inspecting
// messages. Messages never contain tokens, hashes or raw request payloads.

export type RegistryErrorCode =
  'invalid_input' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'immutable'

export class RegistryError extends Error {
  readonly code: RegistryErrorCode

  constructor(code: RegistryErrorCode, message: string) {
    super(message)
    this.name = 'RegistryError'
    this.code = code
  }
}

export function invalidInput(message: string): RegistryError {
  return new RegistryError('invalid_input', message)
}

export function unauthorized(message = 'A valid bearer token is required.'): RegistryError {
  return new RegistryError('unauthorized', message)
}

export function forbidden(
  message = 'The authenticated provider does not own this resource.',
): RegistryError {
  return new RegistryError('forbidden', message)
}

export function notFound(message = 'The requested resource does not exist.'): RegistryError {
  return new RegistryError('not_found', message)
}

export function conflict(message: string): RegistryError {
  return new RegistryError('conflict', message)
}

export function immutable(message = 'Published registry data is immutable.'): RegistryError {
  return new RegistryError('immutable', message)
}

export function isRegistryError(error: unknown): error is RegistryError {
  return error instanceof RegistryError
}
