// Durable publication-event feed helpers (issue #116).
//
// The feed is append-only and read in ascending feed order. Its cursor is an
// opaque encoding of the last consumed feed position, so clients never depend
// on the internal sequence value and a cursor remains stable across process
// restarts. A new publication appends after every existing position and cannot
// shift an already-issued cursor.

import { invalidInput } from './errors'

/** Default and maximum page size of the public event feed. */
export const DEFAULT_PUBLICATION_EVENT_PAGE_LIMIT = 50
export const MAX_PUBLICATION_EVENT_PAGE_LIMIT = 100

const CURSOR_PREFIX = 'rulebook-events:'
const MAX_CURSOR_LENGTH = 64
const CURSOR_VALUE_PATTERN = /^rulebook-events:(0|[1-9]\d{0,14})$/

/** Encodes an internal feed position as the opaque public cursor. */
export function encodePublicationEventCursor(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('publication event cursor position must be a non-negative safe integer')
  }
  return Buffer.from(`${CURSOR_PREFIX}${String(sequence)}`, 'utf8').toString('base64url')
}

/**
 * Decodes a client-supplied cursor. Node's `base64url` decoder is lenient, so
 * the input is accepted only when it re-encodes to exactly the same text; any
 * other value is a typed client error rather than a silently empty page.
 */
export function decodePublicationEventCursor(raw: string): number {
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) {
    throw invalidInput('cursor is not a valid publication-event cursor')
  }
  const decoded = Buffer.from(raw, 'base64url').toString('utf8')
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== raw) {
    throw invalidInput('cursor is not a valid publication-event cursor')
  }
  const match = CURSOR_VALUE_PATTERN.exec(decoded)
  if (match === null) {
    throw invalidInput('cursor is not a valid publication-event cursor')
  }
  const sequence = Number(match[1])
  if (!Number.isSafeInteger(sequence)) {
    throw invalidInput('cursor is not a valid publication-event cursor')
  }
  return sequence
}
