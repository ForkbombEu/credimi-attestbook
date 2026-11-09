import { describe, expect, test } from 'bun:test'

import { isRegistryError } from '../registry/errors'
import { VALIDATION_DIMENSIONS } from '../validation'
import type { CredentialValidationResult, CredentialValidationService } from '../validation'

import { mockCaptureEnvelopes } from './adapters'
import {
  CAPTURE_EXPLORER_LIMITATIONS,
  createMockCaptureExplorer,
  parseCaptureCorrelationInput,
} from './explorer'

const NOW = new Date('2026-11-09T10:00:00.000Z')

const PINNED_RESULT: CredentialValidationResult = {
  validationId: 'validation-1',
  validatedAt: '2026-11-09T09:59:00.000Z',
  rulebook: {
    id: 'rulebook-1',
    name: 'PID Rulebook',
    version: '1.0',
    digest: 'a'.repeat(64),
    digestVerified: true,
    specVersion: 'ts11@1.0.1',
    status: 'published',
  },
  attestation: {
    name: 'Person Identification Data',
    attestationLoS: 'iso_18045_high',
    bindingType: 'cryptographic',
    supportedFormats: ['dc+sd-jwt'],
  },
  credential: {
    format: 'dc+sd-jwt',
    vct: 'urn:example:attestbook:mock:pid:1',
    disclosureCount: 0,
    keyBindingPresent: false,
  },
  schemaReferences: [],
  dimensions: VALIDATION_DIMENSIONS.map((id) => ({
    id,
    status: 'NOT_TESTED' as const,
    applicable: true,
    executed: false,
    findings: [],
    evidence: { scope: 'not executed', reason: 'this fake never executes a check', details: {} },
  })),
  violations: [],
  limitations: [],
  overallStatus: 'NOT_TESTED',
}

interface FakeValidation {
  readonly service: CredentialValidationService
  readonly calls: unknown[]
}

function fakeValidation(result: CredentialValidationResult = PINNED_RESULT): FakeValidation {
  const calls: unknown[] = []
  return {
    calls,
    service: {
      validate(input: unknown): Promise<CredentialValidationResult> {
        calls.push(input)
        return Promise.resolve(result)
      },
    },
  }
}

function explorerWith(validation: FakeValidation, extra: readonly unknown[] = []) {
  return createMockCaptureExplorer({
    validation: validation.service,
    additionalIssuerEnvelopes: extra,
    now: () => NOW,
  })
}

function expectConflict(error: unknown): void {
  expect(isRegistryError(error)).toBe(true)
  if (isRegistryError(error)) {
    expect(error.code).toBe('conflict')
  }
}

describe('capture explorer list', () => {
  test('lists the deterministic mock captures newest first and labels the mock transport', async () => {
    const explorer = explorerWith(fakeValidation())
    const page = await explorer.list()

    expect(page.total).toBe(7)
    expect(page.limit).toBe(50)
    expect(page.offset).toBe(0)
    expect(page.captures).toHaveLength(7)
    for (const capture of page.captures) {
      expect(capture.source.transport).toBe('mock')
      expect(capture.source.description).toContain('no live capture endpoint')
    }
    const times = page.captures.map((capture) => capture.provenance.capturedAtMs)
    expect(times).toEqual([...times].sort((left, right) => right - left))
    expect(page.captures[0]?.artifactType).toBe('error-response')
  })

  test('pages the in-memory capture list without changing the total', async () => {
    const explorer = explorerWith(fakeValidation())
    const page = await explorer.list({ limit: 3, offset: 2 })

    expect(page.total).toBe(7)
    expect(page.limit).toBe(3)
    expect(page.offset).toBe(2)
    expect(page.captures).toHaveLength(3)
  })

  test('reports missing test-execution references and unbound captures explicitly', async () => {
    const [firstEnvelope] = mockCaptureEnvelopes('capture-issuer')
    if (firstEnvelope === undefined) {
      throw new Error('the mock fixtures must contain an issuer envelope')
    }
    const envelope = structuredClone(firstEnvelope)
    delete envelope['testExecutionRef']
    const captureId = 'mock-capture-no-test-execution'
    envelope['captureId'] = captureId
    const explorer = explorerWith(fakeValidation(), [envelope])

    const detail = await explorer.get(captureId)
    expect(detail).not.toBeNull()
    expect(detail?.testExecutionRef).toBeNull()
    expect(detail?.evidenceComplete).toBe(false)
    expect(detail?.evidenceGaps.map((gap) => gap.code)).toContain('no_test_execution_reference')
    expect(detail?.evidenceGaps.map((gap) => gap.code)).toContain('external_artifact_not_fetched')
    expect(detail?.evidenceGaps.map((gap) => gap.code)).toContain('no_rulebook_binding')
  })

  test('returns null for an unknown capture', async () => {
    const explorer = explorerWith(fakeValidation())
    expect(await explorer.get('does-not-exist')).toBeNull()
  })
})

describe('capture explorer detail', () => {
  test('shows inline evidence only through the redacted projection', async () => {
    const explorer = explorerWith(fakeValidation())
    const detail = await explorer.get('mock-capture-capture-issuer-3')

    expect(detail).not.toBeNull()
    expect(detail?.declaredRedaction.status).toBe('none')
    expect(detail?.artifact.availability).toBe('inline')
    expect(detail?.artifactProjection).not.toBeNull()
    expect(detail?.artifactProjection?.redaction.status).toBe('partial')
    expect(detail?.artifactProjection?.redaction.redactedPaths).toContain('/claims')
    const serialized = JSON.stringify(detail)
    expect(serialized).not.toContain('synthetic-access-token-not-a-secret')
    expect(serialized).not.toContain('"given_name":"Test"')
    expect(serialized).not.toContain('Ada')
    expect(detail?.artifactProjection?.document).not.toBeNull()
  })

  test('reports an external reference as unavailable evidence', async () => {
    const explorer = explorerWith(fakeValidation())
    const detail = await explorer.get('mock-capture-capture-issuer-1')

    expect(detail?.artifact.availability).toBe('external')
    expect(detail?.artifactProjection).toBeNull()
    expect(detail?.artifact.uri).toBe('https://artifacts.example.test/mock/issuer-metadata.json')
    expect(detail?.integrity.verified).toBe(false)
    expect(detail?.evidenceGaps.map((gap) => gap.code)).toContain('external_artifact_not_fetched')
  })

  test('returns the explicit explorer limitations', async () => {
    const explorer = explorerWith(fakeValidation())
    const detail = await explorer.get('mock-capture-capture-issuer-3')
    expect(detail?.limitations).toEqual([...CAPTURE_EXPLORER_LIMITATIONS])
    expect(detail?.limitations.join(' ')).toContain('mock')
  })
})

describe('capture explorer correlation', () => {
  test('binds a captured issued credential to the pinned rulebook version', async () => {
    const validation = fakeValidation()
    const explorer = explorerWith(validation)
    const result = await explorer.correlate('mock-capture-capture-issuer-3', {
      rulebookId: 'rulebook-1',
      rulebookVersion: '1.0',
      attestationType: 'Person Identification Data',
      rulebookDigest: 'a'.repeat(64),
    })

    expect(result.captureId).toBe('mock-capture-capture-issuer-3')
    expect(result.correlationId).toBe('mock-correlation-3')
    expect(result.testExecutionRef).toBe('mock-execution-3')
    expect(result.rulebook).toEqual({
      rulebookId: 'rulebook-1',
      rulebookName: 'PID Rulebook',
      version: '1.0',
      contentDigest: 'a'.repeat(64),
      digestVerified: true,
      specVersion: 'ts11@1.0.1',
      rulebookStatus: 'published',
      attestationType: 'Person Identification Data',
      boundAt: NOW.toISOString(),
    })
    expect(result.validation).toEqual(PINNED_RESULT)
    expect(validation.calls).toHaveLength(1)
    const sent = validation.calls[0] as { readonly credential: string }
    expect(sent.credential).toContain('urn:example:attestbook:mock:pid:1')

    const detail = await explorer.get('mock-capture-capture-issuer-3')
    expect(detail?.rulebook?.contentDigest).toBe('a'.repeat(64))
    expect(detail?.validation?.overallStatus).toBe('NOT_TESTED')
    expect(detail?.validationResult).toEqual(PINNED_RESULT)
    expect(detail?.evidenceGaps.map((gap) => gap.code)).not.toContain('validation_not_run')
    expect(detail?.timeline.map((event) => event.kind)).toEqual([
      'captured',
      'validated',
      'received',
      'bound',
    ])
    const times = detail?.timeline.map((event) => Date.parse(event.at)) ?? []
    expect(times).toEqual([...times].sort((left, right) => left - right))
  })

  test('keeps evidence and correlations instance-local with no shared store', async () => {
    const validation = fakeValidation()
    const first = explorerWith(validation)
    await first.correlate('mock-capture-capture-issuer-3', {
      rulebookId: 'rulebook-1',
      rulebookVersion: '1.0',
      attestationType: 'Person Identification Data',
      rulebookDigest: 'a'.repeat(64),
    })
    expect((await first.get('mock-capture-capture-issuer-3'))?.validation).not.toBeNull()

    // The explorer is constructed without a database or filesystem dependency,
    // so a second instance has no shared store from which to reload the first
    // instance's evidence or correlation. This asserts instance isolation; the
    // no-persistence claim itself rests on the dependency-free constructor.
    const second = explorerWith(validation)
    const detail = await second.get('mock-capture-capture-issuer-3')
    expect(detail?.validation).toBeNull()
    expect(detail?.validationResult).toBeNull()
    expect(detail?.rulebook).toBeNull()
    expect(detail?.limitations.join(' ')).toContain(
      'held in memory for the lifetime of this server process',
    )
  })

  test('refuses to validate an external artifact reference', async () => {
    const validation = fakeValidation()
    const explorer = explorerWith(validation)
    try {
      await explorer.correlate('mock-capture-capture-issuer-1', {
        rulebookId: 'rulebook-1',
        rulebookVersion: '1.0',
        attestationType: 'Person Identification Data',
      })
      throw new Error('correlation must reject external evidence')
    } catch (error) {
      expectConflict(error)
      if (isRegistryError(error)) {
        expect(error.message).toContain('external reference')
      }
    }
    expect(validation.calls).toHaveLength(0)
  })

  test('refuses to validate an artifact type that carries no credential', async () => {
    const validation = fakeValidation()
    const explorer = explorerWith(validation)
    try {
      await explorer.correlate('mock-capture-capture-verifier-2', {
        rulebookId: 'rulebook-1',
        rulebookVersion: '1.0',
        attestationType: 'Person Identification Data',
      })
      throw new Error('correlation must reject a non-credential artifact')
    } catch (error) {
      expectConflict(error)
      if (isRegistryError(error)) {
        expect(error.message).toContain('not applicable')
      }
    }
    expect(validation.calls).toHaveLength(0)
  })

  test('reports an unknown capture as not found', async () => {
    const explorer = explorerWith(fakeValidation())
    try {
      await explorer.correlate('does-not-exist', {
        rulebookId: 'rulebook-1',
        rulebookVersion: '1.0',
        attestationType: 'Person Identification Data',
      })
      throw new Error('correlation must reject an unknown capture')
    } catch (error) {
      expect(isRegistryError(error)).toBe(true)
      if (isRegistryError(error)) {
        expect(error.code).toBe('not_found')
      }
    }
  })

  test('rejects a malformed correlation request before running validation', async () => {
    const validation = fakeValidation()
    const explorer = explorerWith(validation)
    try {
      await explorer.correlate('mock-capture-capture-issuer-3', {
        rulebookId: 'rulebook-1',
        rulebookVersion: 'not-a-version',
        attestationType: 'PID',
      })
      throw new Error('correlation must reject a malformed version')
    } catch (error) {
      expect(isRegistryError(error)).toBe(true)
      if (isRegistryError(error)) {
        expect(error.code).toBe('invalid_input')
      }
    }
    expect(validation.calls).toHaveLength(0)
  })

  test('refuses a stale pinned digest without replacing the recorded correlation', async () => {
    const staleResult: CredentialValidationResult = {
      ...PINNED_RESULT,
      validationId: 'validation-2',
      rulebook: { ...PINNED_RESULT.rulebook, digest: 'b'.repeat(64) },
    }
    const results: readonly CredentialValidationResult[] = [PINNED_RESULT, staleResult]
    let index = 0
    const service: CredentialValidationService = {
      validate() {
        const result = results[index] ?? PINNED_RESULT
        index += 1
        return Promise.resolve(result)
      },
    }
    const explorer = createMockCaptureExplorer({ validation: service, now: () => NOW })
    const captureId = 'mock-capture-capture-issuer-3'
    const first = await explorer.correlate(captureId, {
      rulebookId: 'rulebook-1',
      rulebookVersion: '1.0',
      attestationType: 'Person Identification Data',
      rulebookDigest: 'a'.repeat(64),
    })

    try {
      await explorer.correlate(captureId, {
        rulebookId: 'rulebook-1',
        rulebookVersion: '1.0',
        attestationType: 'Person Identification Data',
        rulebookDigest: '0'.repeat(64),
      })
      throw new Error('correlation must reject a stale digest')
    } catch (error) {
      expectConflict(error)
      if (isRegistryError(error)) {
        expect(error.message).toContain('nothing was recorded')
      }
    }

    const detail = await explorer.get(captureId)
    expect(detail?.rulebook?.contentDigest).toBe('a'.repeat(64))
    expect(detail?.validationResult?.validationId).toBe(first.validation.validationId)
  })

  test('rejects a malformed digest before running validation', async () => {
    const validation = fakeValidation()
    const explorer = explorerWith(validation)
    try {
      await explorer.correlate('mock-capture-capture-issuer-3', {
        rulebookId: 'rulebook-1',
        rulebookVersion: '1.0',
        attestationType: 'Person Identification Data',
        rulebookDigest: 'ABC',
      })
      throw new Error('correlation must reject a malformed digest')
    } catch (error) {
      expect(isRegistryError(error)).toBe(true)
      if (isRegistryError(error)) {
        expect(error.code).toBe('invalid_input')
      }
    }
    expect(validation.calls).toHaveLength(0)
  })

  test('keeps the pinned digest optional for callers that omit it', async () => {
    const explorer = explorerWith(fakeValidation())
    const result = await explorer.correlate('mock-capture-capture-issuer-3', {
      rulebookId: 'rulebook-1',
      rulebookVersion: '1.0',
      attestationType: 'Person Identification Data',
    })

    expect(result.rulebook.contentDigest).toBe('a'.repeat(64))
  })
})

describe('capture correlation request parsing', () => {
  test('normalises a valid request', () => {
    expect(
      parseCaptureCorrelationInput({
        rulebookId: ' rulebook-1 ',
        rulebookVersion: '1.0',
        attestationType: 'PID',
      }),
    ).toEqual({
      rulebookId: 'rulebook-1',
      rulebookVersion: '1.0',
      attestationType: 'PID',
      rulebookDigest: null,
    })
  })

  test('accepts an optional digest and rejects a malformed one', () => {
    const base = {
      rulebookId: 'rulebook-1',
      rulebookVersion: '1.0',
      attestationType: 'PID',
    }

    expect(
      parseCaptureCorrelationInput({ ...base, rulebookDigest: 'a'.repeat(64) }).rulebookDigest,
    ).toBe('a'.repeat(64))
    expect(
      parseCaptureCorrelationInput({ ...base, rulebookDigest: null }).rulebookDigest,
    ).toBeNull()

    try {
      parseCaptureCorrelationInput({ ...base, rulebookDigest: 'ABC' })
      throw new Error('a malformed digest must be rejected')
    } catch (error) {
      expect(isRegistryError(error)).toBe(true)
      if (isRegistryError(error)) {
        expect(error.code).toBe('invalid_input')
      }
    }
  })
})
