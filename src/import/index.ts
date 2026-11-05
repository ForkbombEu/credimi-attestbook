// Public surface of the AttestBook untrusted-import pipeline (issues #30 and
// #31).
//
// See docs/import.md for the supported sources, §15 controls, limits,
// conformance classification, provenance, re-import identity and limitations.

export {
  RulebookImporter,
  type ImportConflict,
  type ImportConflictCode,
  type ImportEntryDisposition,
  type ImportEntryResult,
  type ImportResult,
  type RulebookImporterOptions,
} from './importer'

export {
  previewImport,
  type ImportCompatibility,
  type ImportOptions,
  type ImportPreview,
  type ImportSource,
  type ImportSourceInfo,
  type JsonImportSource,
  type UrlImportSource,
} from './preview'

export {
  CONFORMANCE_CLASSIFICATIONS,
  previewCatalogEntry,
  type ConformanceClassification,
  type ImportDiagnostic,
  type ImportDiagnosticKind,
  type ImportEntryPreview,
  type ImportEntryStructuralStatus,
  type ImportedSchemaReference,
  type SourceConformanceSignal,
} from './validate'

export {
  DEFAULT_IMPORT_LIMITS,
  resolveImportLimits,
  type ImportLimitOverrides,
  type ImportLimits,
} from './limits'

export { ImportError, isImportError, type ImportErrorCode } from './errors'

export {
  CATALOG_ENVELOPE_MEMBERS,
  type CatalogEnvelopeKind,
  type ExtractedCatalog,
} from './catalog'

export {
  createHttpsTransport,
  type CreateHttpsTransportOptions,
  type ImportHttpRequest,
  type ImportHttpResponse,
  type ImportHttpTransport,
} from './http'

export { type HostAddress, type HostResolver } from './url'
