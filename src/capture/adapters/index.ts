// Public surface of the capture transport adapters (FR-018, issue #47).
//
// Only the deterministic mock source is implemented. A future transport
// adapter implements `CapturePullAdapter`/`CapturePushAdapter`; nothing else in
// the capture module changes. This module makes no live capture claim.

export {
  CAPTURE_ADAPTER_TRANSPORTS,
  type CaptureAdapterTransport,
  type CapturePullAdapter,
  type CapturePullRequest,
  type CapturePullResult,
  type CapturePushAdapter,
  type CapturePushResult,
  type CapturePushSubmission,
  type CaptureSource,
} from './types'

export {
  CaptureAdapterError,
  captureAdapterError,
  isCaptureAdapterError,
  type CaptureAdapterErrorCode,
} from './errors'

export {
  hashCaptureCredential,
  isCaptureCredentialHash,
  verifyCaptureCredential,
  verifyCaptureCredentialHash,
} from './credentials'

export { mockCaptureEnvelopes } from './fixtures'

export {
  CAPTURE_MOCK_FAULTS,
  DEFAULT_MOCK_BATCH_SIZE,
  MockCaptureSource,
  type CaptureMockFault,
  type MockCaptureSourceOptions,
} from './mock'
