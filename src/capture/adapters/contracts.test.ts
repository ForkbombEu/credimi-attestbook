// Extension-contract tests for capture ingestion (FR-018, issue #47).
//
// The pull and push interfaces must be usable by an adapter that is not the
// mock source, so transport-specific integration can be added later without
// touching the normalization pipeline or its callers. These in-test adapters
// implement only the published interfaces and are driven through them.

import { describe, expect, test } from 'bun:test'

import { normalizeCaptureArtifact, parseCaptureArtifact } from '../normalize'
import { CAPTURE_ARTIFACT_KIND } from '../types'
import { mockCaptureEnvelopes } from './fixtures'
import { MockCaptureSource } from './mock'
import type {
  CapturePullAdapter,
  CapturePullResult,
  CapturePushAdapter,
  CapturePushResult,
  CapturePushSubmission,
  CaptureSource,
} from './types'

const FIXED_NOW = new Date('2026-11-05T09:50:00.000Z')
const SOURCE: CaptureSource = {
  sourceId: 'test-fixed-source',
  component: 'capture-issuer',
  transport: 'mock',
  description: 'In-test adapter, not a live capture source',
}

class FixedPullAdapter implements CapturePullAdapter {
  readonly source = SOURCE
  private delivered = false

  pull(): Promise<CapturePullResult> {
    if (this.delivered) {
      return Promise.resolve({
        source: SOURCE,
        artifacts: [],
        nextCursor: null,
        receivedAt: FIXED_NOW.toISOString(),
      })
    }
    this.delivered = true
    const envelope = mockCaptureEnvelopes('capture-issuer')[0]
    const normalized = normalizeCaptureArtifact(envelope, { now: () => FIXED_NOW })
    return Promise.resolve({
      source: SOURCE,
      artifacts: [normalized],
      nextCursor: 'fixed-cursor:1',
      receivedAt: normalized.envelope.provenance.receivedAt,
    })
  }
}

class NormalizingPushAdapter implements CapturePushAdapter {
  readonly source = SOURCE

  push(submission: CapturePushSubmission): Promise<CapturePushResult> {
    const normalized = parseCaptureArtifact(submission.bytes, { now: () => FIXED_NOW })
    return Promise.resolve({
      source: SOURCE,
      normalized,
      duplicate: false,
      receivedAt: normalized.envelope.provenance.receivedAt,
    })
  }
}

/** Drives any pull adapter through the interface alone. */
async function collect(adapter: CapturePullAdapter): Promise<CapturePullResult[]> {
  const pages: CapturePullResult[] = []
  let cursor: string | null = null
  for (let page = 0; page < 10; page += 1) {
    const result = await adapter.pull({ cursor })
    pages.push(result)
    if (result.nextCursor === null) {
      return pages
    }
    cursor = result.nextCursor
  }
  throw new Error('the pull adapter did not terminate')
}

describe('adapter extension contracts', () => {
  test('an in-test pull adapter works through the published interface', async () => {
    const pages = await collect(new FixedPullAdapter())
    expect(pages).toHaveLength(2)
    expect(pages[0]?.artifacts).toHaveLength(1)
    expect(pages[0]?.artifacts[0]?.envelope.kind).toBe(CAPTURE_ARTIFACT_KIND)
    expect(pages[1]?.artifacts).toHaveLength(0)
  })

  test('the mock source satisfies both interfaces for a generic caller', () => {
    const mock = new MockCaptureSource({
      component: 'capture-verifier',
      acceptedCredentialHashes: [],
      pullCredential: null,
    })
    const pullAdapter: CapturePullAdapter = mock
    const pushAdapter: CapturePushAdapter = mock
    expect(pullAdapter.source).toBe(pushAdapter.source)
    expect(pullAdapter.source.transport).toBe('mock')
  })

  test('an in-test push adapter normalizes through the published interface', async () => {
    const adapter: CapturePushAdapter = new NormalizingPushAdapter()
    const envelope = mockCaptureEnvelopes('capture-issuer')[2]
    const result = await adapter.push({
      authorization: null,
      mediaType: 'application/json',
      bytes: new TextEncoder().encode(JSON.stringify(envelope)),
    })
    expect(result.source).toBe(SOURCE)
    expect(result.normalized.envelope.artifactType).toBe('issued-credential')
    expect(result.normalized.sensitive).not.toBeNull()
  })
})
