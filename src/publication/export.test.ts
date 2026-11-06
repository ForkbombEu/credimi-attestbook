// Unit tests for the publication export manifest (issue #42).
//
// The manifest is built only from frozen data: the version row, the exact
// stored bytes and the snapshot document. These tests pin the fields, the
// digest verification, the deliberate absence of a fabricated signature and
// the safe download filename.

import { describe, expect, test } from 'bun:test'

import { sha256Hex } from '../registry/digest'
import type { RulebookVersion } from '../registry/types'
import { serializeRulebookVersion, type RulebookVersionDocument } from '../registry/versioning'

import {
  buildPublicationExportManifest,
  publicationExportFilename,
  PUBLICATION_EXPORT_FORMAT,
  PUBLICATION_SIGNATURE_REASON,
} from './export'

function snapshotDocument(): RulebookVersionDocument {
  return {
    format: 'attestbook.rulebook-version@1',
    rulebookId: 'rulebook-1',
    version: '1.0',
    specVersion: 'ts11@1.0.1',
    name: 'Publication Rulebook',
    description: 'Frozen content.',
    sourceUrl: 'https://issuer.example.org/rulebooks/publication',
    attestations: [
      {
        name: 'Person Identification Data',
        attestationLoS: 'iso_18045_high',
        bindingType: 'key',
        supportedFormats: ['dc+sd-jwt'],
        schemaReferences: [
          {
            formatIdentifier: 'dc+sd-jwt',
            uri: 'https://issuer.example.org/schemas/pid',
            integrity: null,
          },
        ],
      },
    ],
    schemaReferences: [],
  }
}

const bytes = serializeRulebookVersion(snapshotDocument())
const contentDigest = sha256Hex(bytes)

const publishedVersion: RulebookVersion = {
  id: 'version-1',
  rulebookId: 'rulebook-1',
  version: '1.0',
  status: 'published',
  contentDigest,
  specVersion: 'ts11@1.0.1',
  provenance: { adapter: 'ts11', sourceDigest: contentDigest },
  createdAt: '2026-01-01T00:00:00.000Z',
  publishedAt: '2026-01-01T00:00:01.000Z',
}

function input(overrides: Partial<Parameters<typeof buildPublicationExportManifest>[0]> = {}) {
  return {
    version: publishedVersion,
    providerId: 'provider-1',
    mediaType: 'application/vnd.attestbook.rulebook-version+json',
    bytes,
    document: snapshotDocument(),
    ...overrides,
  }
}

describe('publication export manifest', () => {
  test('describes the frozen artifact, its integrity and its provenance', () => {
    const manifest = buildPublicationExportManifest(input())

    expect(manifest).toMatchObject({
      format: PUBLICATION_EXPORT_FORMAT,
      rulebookId: 'rulebook-1',
      providerId: 'provider-1',
      version: '1.0',
      status: 'published',
      name: 'Publication Rulebook',
      sourceUrl: 'https://issuer.example.org/rulebooks/publication',
      specVersion: 'ts11@1.0.1',
      mediaType: 'application/vnd.attestbook.rulebook-version+json',
      contentDigest,
      byteLength: bytes.byteLength,
      createdAt: '2026-01-01T00:00:00.000Z',
      publishedAt: '2026-01-01T00:00:01.000Z',
      provenance: { adapter: 'ts11', sourceDigest: contentDigest },
      integrity: { algorithm: 'sha256', verified: true },
    })
    expect(manifest.signature.status).toBe('unsupported')
    expect(manifest.signature.reason).toBe(PUBLICATION_SIGNATURE_REASON)
    expect(manifest.signature.reason).toContain('OWF 0.5.4')
    expect(manifest.limitations.length).toBeGreaterThan(0)
    expect(manifest.limitations.join(' ')).toContain('SHA-256')
  })

  test('is deterministic for the same frozen version', () => {
    expect(buildPublicationExportManifest(input())).toEqual(buildPublicationExportManifest(input()))
  })

  test('uses only the snapshot identity and never mutable rulebook fields', () => {
    // The builder has no rulebook input at all; the name and source URL in the
    // manifest come from the frozen document, so a later working-copy rename
    // cannot change what a published artifact exports as.
    const frozen = { ...snapshotDocument(), name: 'Frozen Name' }
    const frozenBytes = serializeRulebookVersion(frozen)
    const manifest = buildPublicationExportManifest({
      version: {
        ...publishedVersion,
        contentDigest: sha256Hex(frozenBytes),
      },
      providerId: 'provider-1',
      mediaType: 'application/vnd.attestbook.rulebook-version+json',
      bytes: frozenBytes,
      document: frozen,
    })
    expect(manifest.name).toBe('Frozen Name')
  })

  test('refuses to export a draft version', () => {
    expect(() =>
      buildPublicationExportManifest(
        input({ version: { ...publishedVersion, status: 'draft', publishedAt: null } }),
      ),
    ).toThrow('draft')
  })

  test('refuses a non-draft version without its publication time', () => {
    expect(() =>
      buildPublicationExportManifest(
        input({ version: { ...publishedVersion, publishedAt: null } }),
      ),
    ).toThrow('publication time')
  })

  test('refuses stored bytes that no longer match the recorded digest', () => {
    const tampered = new TextEncoder().encode('{"format":"tampered"}')
    expect(() => buildPublicationExportManifest(input({ bytes: tampered }))).toThrow(
      'not the recorded',
    )
  })

  test('refuses a snapshot document that belongs to another version', () => {
    expect(() =>
      buildPublicationExportManifest(
        input({ document: { ...snapshotDocument(), version: '9.9' } }),
      ),
    ).toThrow('does not match')
  })
})

describe('publication export filename', () => {
  test('derives a bounded ASCII attachment name', () => {
    expect(publicationExportFilename('PID Rulebook', '1.0')).toBe(
      'attestbook-pid-rulebook-1.0.json',
    )
    expect(publicationExportFilename('  **  ', '1.0')).toBe('attestbook-rulebook-1.0.json')
  })

  test('neutralises header-injection and path characters in an untrusted name', () => {
    const filename = publicationExportFilename(
      'Evil"\r\nContent-Type: text/html; /../etc/passwd',
      '1.0',
    )
    expect(filename).toBe('attestbook-evil-content-type-text-html-etc-passwd-1.0.json')
    expect(filename).not.toContain('"')
    expect(filename).not.toContain('\r')
    expect(filename).not.toContain('\n')
    expect(filename).not.toContain('/')
  })

  test('bounds the slug length and sanitises the version label', () => {
    const filename = publicationExportFilename('a'.repeat(500), '1.0 beta')
    expect(filename.startsWith('attestbook-')).toBe(true)
    expect(filename.endsWith('-1.0-beta.json')).toBe(true)
    expect(filename.length).toBeLessThan(120)
  })
})
