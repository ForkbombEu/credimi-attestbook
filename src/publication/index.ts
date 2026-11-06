// Publication export boundary (issue #42).
//
// Production code imports the stable export surface from this barrel; the
// manifest and filename helpers are pure and carry no registry coupling.

export {
  buildPublicationExportManifest,
  publicationExportFilename,
  PUBLICATION_EXPORT_FORMAT,
  PUBLICATION_EXPORT_LIMITATIONS,
  PUBLICATION_SIGNATURE_REASON,
} from './export'
export type {
  BuildPublicationExportInput,
  ExportablePublicationStatus,
  PublicationExportIntegrity,
  PublicationExportManifest,
  PublicationExportSignature,
  PublicationSignatureStatus,
} from './export'
