// Credential format recognition for the validation engine (issue #32).
//
// Only `dc+sd-jwt` has a structural parser in this slice. The other TS11
// formats are recognised so the engine can report them explicitly instead of
// pretending a generic JSON validator means mdoc or W3C VC support (FR-011).

import { TS11_FORMAT_VALUES } from '../standards/profiles'

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

/** Formats with a real structural parser in this slice. */
export const STRUCTURAL_PARSER_FORMATS = ['dc+sd-jwt'] as const
export type StructuralParserFormat = (typeof STRUCTURAL_PARSER_FORMATS)[number]

export interface CredentialArtifact {
  readonly value: string
  /** Explicit caller hint; never trusted to make an artifact parseable. */
  readonly format?: string
}

export interface FormatRecognition {
  readonly format: string | null
  readonly recognized: boolean
  readonly parserAvailable: boolean
  /** `hint` means only the caller's declared format backs the recognition. */
  readonly source: 'detected' | 'hint'
}

function isCompactJwt(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 3 && parts.every((part) => part !== '' && BASE64URL_PATTERN.test(part))
}

function firstByte(value: string): number | null {
  if (!BASE64URL_PATTERN.test(value)) {
    return null
  }
  try {
    const bytes = Buffer.from(value, 'base64url')
    return bytes.length === 0 ? null : (bytes[0] ?? null)
  } catch {
    return null
  }
}

function isCborMap(value: string): boolean {
  const byte = firstByte(value)
  return byte !== null && byte >= 0xa0 && byte <= 0xbf
}

/**
 * Heuristic auto-detection used only when the caller supplies a bare string.
 * A JWT VC without SD-JWT disclosures is recognised as `jwt_vc_json` but is not
 * structurally parsed in this slice.
 */
export function detectCredentialFormat(value: string): string | null {
  if (value.includes('~') && isCompactJwt(value.split('~')[0] ?? '')) {
    return 'dc+sd-jwt'
  }
  if (isCompactJwt(value)) {
    return 'jwt_vc_json'
  }
  if (isCborMap(value)) {
    return 'mso_mdoc'
  }
  return null
}

export function recognizeCredentialFormat(artifact: CredentialArtifact): FormatRecognition {
  if (artifact.format !== undefined) {
    const known = (TS11_FORMAT_VALUES as readonly string[]).includes(artifact.format)
    return {
      format: artifact.format,
      recognized: known,
      parserAvailable: known && artifact.format === 'dc+sd-jwt',
      source: 'hint',
    }
  }
  const detected = detectCredentialFormat(artifact.value)
  return {
    format: detected,
    recognized: detected !== null,
    parserAvailable: detected === 'dc+sd-jwt',
    source: 'detected',
  }
}
