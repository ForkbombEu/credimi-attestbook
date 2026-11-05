// Small wire-format predicates shared by the TS11 and OWF codecs.
//
// These are format checks only. SchemaMeta structural validation is delegated
// to the real OWF package for the OWF profile and implemented in `./ts11.ts`
// for the TS11 profile, because OWF 0.5.4 cannot validate the TS11 wire shape.

import { invalidInput, type AdapterDiagnostic } from './diagnostics'

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const SRI_PATTERN = /^(sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}$/

const INTEGRITY_MARKER = '#integrity='

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export function isSemVer(value: string): boolean {
  return SEMVER_PATTERN.test(value)
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

export function isAbsoluteUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol !== ''
  } catch {
    return false
  }
}

export interface SriValue {
  readonly algorithm: 'sha256' | 'sha384' | 'sha512'
  readonly value: string
}

export function parseSri(value: string): SriValue | undefined {
  const match = SRI_PATTERN.exec(value)
  if (match === null) {
    return undefined
  }
  const algorithm = match[1]
  if (algorithm !== 'sha256' && algorithm !== 'sha384' && algorithm !== 'sha512') {
    return undefined
  }
  return { algorithm, value }
}

export interface SplitReference {
  readonly uri: string
  readonly integrity?: string
}

export interface MalformedReference {
  readonly uri: string
  readonly problem: string
}

export function splitIntegrityReference(value: string): SplitReference | MalformedReference {
  const index = value.indexOf(INTEGRITY_MARKER)
  if (index === -1) {
    return { uri: value }
  }
  if (index !== value.lastIndexOf(INTEGRITY_MARKER)) {
    return { uri: value, problem: 'contains more than one #integrity= fragment' }
  }

  const uri = value.slice(0, index)
  const integrity = value.slice(index + INTEGRITY_MARKER.length)
  if (uri === '') {
    return { uri: value, problem: 'has an #integrity= fragment but no URI' }
  }
  if (integrity === '') {
    return { uri: value, problem: 'has an empty #integrity= value' }
  }

  return { uri, integrity }
}

export function isMalformedReference(
  split: SplitReference | MalformedReference,
): split is MalformedReference {
  return 'problem' in split
}

/** Parses a URI that may carry a W3C SRI `#integrity=` fragment. */
export function parseReference(
  raw: unknown,
  path: string,
  diagnostics: AdapterDiagnostic[],
): SplitReference | undefined {
  if (raw === undefined || raw === null) {
    diagnostics.push(invalidInput('missing_required_member', 'missing required URI member', path))
    return undefined
  }
  if (!isNonEmptyString(raw)) {
    diagnostics.push(invalidInput('invalid_member_value', 'expected a non-empty URI string', path))
    return undefined
  }

  const split = splitIntegrityReference(raw)
  if (isMalformedReference(split)) {
    diagnostics.push(invalidInput('invalid_member_value', split.problem, path))
    return undefined
  }
  if (!isAbsoluteUrl(split.uri)) {
    diagnostics.push(invalidInput('invalid_member_value', 'expected an absolute URI', path))
    return undefined
  }
  if (split.integrity !== undefined && parseSri(split.integrity) === undefined) {
    diagnostics.push(
      invalidInput(
        'invalid_member_value',
        'expected a W3C SRI value such as sha256-<base64> in the #integrity= fragment',
        path,
      ),
    )
    return undefined
  }

  return split
}

export function toReferencedUri(uri: string, integrity: string | undefined): string {
  return integrity === undefined ? uri : `${uri}${INTEGRITY_MARKER}${integrity}`
}
