// Per-attestation schema-reference controls for the draft editor (issue #100).
//
// The component is a builder over the serialized draft document the page owns,
// not a second source of truth: every insert or removal rewrites that text.
// Hosted documents are registered through the administrator session and its
// CSRF token, then the API's canonical URI and SRI pin become ordinary
// `schemaReferences` values. External references are entered directly.

import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent } from 'react'

import { isSessionAuthError, type EditorApi } from '../api'
import { formatDigest, hostedIntegrityState, hostedSchemaDownloadName } from '../detail'
import { Alert } from './Alert'
import { CODE_OUTPUT_CLASS } from './CodeOutput'
import {
  HOSTED_SCHEMA_KIND,
  MAX_HOSTED_SCHEMA_BYTES,
  cborKeywordWarnings,
  credentialTypeKeyword,
  declaredCredentialType,
  insertSchemaReference,
  mdocNamespaces,
  mergeCredentialType,
  previewHostedSchema,
  referenceForFormat,
  removeSchemaReference,
  schemaControlAttestations,
  validateExternalSchema,
  type SchemaControlAttestation,
} from '../schema-reference'
import type { DraftContentDocument, DraftSchemaReference, HostedSchema } from '../types'

type SchemaSource = 'hosted' | 'external'

interface SchemaReferenceControlsProps {
  readonly document: DraftContentDocument
  readonly documentText: string
  /** Attestation whose format rows this instance renders. */
  readonly attestationIndex: number
  readonly disabled: boolean
  /** Null means the administrator session cannot authorize a registration. */
  readonly csrfToken: string | null
  readonly api: EditorApi
  /**
   * Stored-document associations the API resolved for the loaded draft (#103).
   * Keyed by the exact reference URI; registrations made in this view are added
   * locally so a just-inserted reference is identified before it is saved.
   */
  readonly hostedSchemas?: ReadonlyMap<string, HostedSchema>
  readonly onDocumentChange: (text: string) => void
  readonly onSessionExpired: () => void
}

interface ResultNotice {
  readonly title: string
  readonly uri: string
  readonly integrity: string | null
  readonly href: string | null
}

function rowKey(attestationIndex: number, formatIdentifier: string): string {
  return `${attestationIndex}:${formatIdentifier}`
}

function kindLabel(kind: HostedSchema['kind']): string {
  return kind === 'json_schema_2020_12' ? 'JSON Schema 2020-12' : 'SD-JWT VC Type Metadata'
}

function defaultMode(hosted: HostedSchema | null): SchemaSource {
  return hosted === null ? 'external' : 'hosted'
}

function formatName(formatIdentifier: string): string {
  return formatIdentifier === '' ? 'unknown format' : formatIdentifier
}

export function SchemaReferenceControls({
  document,
  documentText,
  attestationIndex,
  disabled,
  csrfToken,
  api,
  hostedSchemas,
  onDocumentChange,
  onSessionExpired,
}: SchemaReferenceControlsProps) {
  const fieldId = useId()
  const prefix = `schema-${fieldId.replaceAll(':', '')}`
  const attestation = useMemo(
    () =>
      schemaControlAttestations(document).find(
        (candidate) => candidate.index === attestationIndex,
      ) ?? null,
    [attestationIndex, document],
  )
  // Registrations made in this view are known associations even though the
  // inserted JSON is the ordinary URI/integrity pair. Loaded associations come
  // from the API, so the row never has to guess from a URL prefix.
  const registeredSchemas = useRef(new Map<string, HostedSchema>())

  const hostedFor = (reference: DraftSchemaReference | null): HostedSchema | null => {
    if (reference === null) {
      return null
    }
    return (
      registeredSchemas.current.get(reference.uri) ??
      hostedSchemas?.get(reference.uri) ??
      reference.hostedSchema ??
      null
    )
  }

  const [openKey, setOpenKey] = useState<string | null>(null)
  const [mode, setMode] = useState<SchemaSource>('hosted')
  const [schemaText, setSchemaText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [externalUri, setExternalUri] = useState('')
  const [externalIntegrity, setExternalIntegrity] = useState('')
  const [credentialType, setCredentialType] = useState('')
  const [fieldErrors, setFieldErrors] = useState<{
    readonly uri?: string
    readonly integrity?: string
  }>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [result, setResult] = useState<ResultNotice | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  // Registration is asynchronous and the attestation section stays editable,
  // so a reference must be inserted into the latest text, never the click-time
  // copy.
  const documentTextRef = useRef(documentText)
  useEffect(() => {
    documentTextRef.current = documentText
  }, [documentText])

  const preview = useMemo(() => previewHostedSchema(schemaText), [schemaText])
  const showPreview = schemaText.trim() !== ''

  const resetForm = () => {
    setSchemaText('')
    setFileName(null)
    setExternalUri('')
    setExternalIntegrity('')
    setCredentialType('')
    setFieldErrors({})
    setFormError(null)
  }

  /**
   * Replaces the hosted schema text and prefills the credential-type field from
   * an existing `properties.<vct|docType>.const`, so re-registering a schema
   * that already declares it does not ask for the same value twice.
   */
  const applySchemaText = (text: string, formatIdentifier: string) => {
    setSchemaText(text)
    setFileName(null)
    setFormError(null)
    const keyword = credentialTypeKeyword(formatIdentifier)
    setCredentialType(keyword === null ? '' : (declaredCredentialType(text, keyword) ?? ''))
  }

  const openForm = (attestation: SchemaControlAttestation, formatIdentifier: string) => {
    const reference = referenceForFormat(attestation, formatIdentifier)
    setOpenKey(rowKey(attestation.index, formatIdentifier))
    setMode(defaultMode(hostedFor(reference)))
    setResult(null)
    setStatus(null)
    resetForm()
  }

  const closeForm = () => {
    setOpenKey(null)
    resetForm()
  }

  const replaceDocument = (nextText: string, notice: ResultNotice, nextStatus: string) => {
    onDocumentChange(nextText)
    setResult(notice)
    setStatus(nextStatus)
    setOpenKey(null)
    resetForm()
  }

  const handleFile = async (event: ChangeEvent<HTMLInputElement>, formatIdentifier: string) => {
    const file = event.target.files?.[0]
    if (file === undefined) {
      return
    }
    setFormError(null)
    if (!file.name.toLowerCase().endsWith('.json')) {
      setFormError('Choose a .json file.')
      return
    }
    if (file.size > MAX_HOSTED_SCHEMA_BYTES) {
      setFormError(
        `The file is ${file.size} bytes; the limit is 256 KiB (${MAX_HOSTED_SCHEMA_BYTES} bytes).`,
      )
      return
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        setFormError('The file starts with a byte-order mark; save it as UTF-8 without a BOM.')
        return
      }
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      } catch {
        setFormError('The file is not valid UTF-8. Save it as UTF-8 and choose it again.')
        return
      }
      setSchemaText(text)
      setFileName(file.name)
      const keyword = credentialTypeKeyword(formatIdentifier)
      setCredentialType(keyword === null ? '' : (declaredCredentialType(text, keyword) ?? ''))
    } catch {
      setFormError('The file could not be read. Choose it again.')
    }
  }

  const handleRegister = async (
    attestation: SchemaControlAttestation,
    formatIdentifier: string,
  ) => {
    const current = previewHostedSchema(schemaText)
    if (!current.ok) {
      setFormError(current.message)
      return
    }
    const keyword = credentialTypeKeyword(formatIdentifier)
    if (keyword === 'docType' && mdocNamespaces(schemaText).length === 0) {
      setFormError(
        'An mso_mdoc schema must declare at least one namespace: a top-level properties member other than docType whose subschema is an object schema.',
      )
      return
    }
    // The entered credential type is written into the exact bytes that are
    // registered. A mismatching existing const/enum stops the registration.
    let textToRegister = schemaText
    const enteredCredentialType = credentialType.trim()
    if (keyword !== null && enteredCredentialType !== '') {
      const merged = mergeCredentialType(schemaText, keyword, enteredCredentialType)
      if (!merged.ok) {
        setFormError(merged.message)
        return
      }
      textToRegister = merged.text
    }
    if (csrfToken === null) {
      onSessionExpired()
      setFormError('Sign in again to register this schema with your administrator session.')
      return
    }
    setWorking(true)
    setFormError(null)
    try {
      const registered = await api.registerSchemaDocument(
        HOSTED_SCHEMA_KIND,
        textToRegister,
        csrfToken,
      )
      registeredSchemas.current.set(registered.url, registered)
      const edit = insertSchemaReference(
        documentTextRef.current,
        attestation.index,
        {
          formatIdentifier,
          uri: registered.url,
          integrity: registered.integrity,
        },
        attestation.name,
      )
      if (!edit.ok) {
        // The document was stored, so keep its URL and SRI visible even when
        // the attestation changed and the reference cannot be inserted.
        setResult({
          title: 'Hosted schema registered but not inserted.',
          uri: registered.url,
          integrity: registered.integrity,
          href: registered.url,
        })
        setFormError(edit.message)
        return
      }
      replaceDocument(
        edit.text,
        {
          title: 'Hosted schema registered and added to the draft.',
          uri: registered.url,
          integrity: registered.integrity,
          href: registered.url,
        },
        `Registered the schema for ${attestation.name} (${formatName(formatIdentifier)}). Save the draft to keep it.`,
      )
    } catch (error) {
      if (isSessionAuthError(error)) {
        onSessionExpired()
        setFormError('Sign in again to register this schema with your administrator session.')
      } else {
        setFormError(
          error instanceof Error && error.message !== ''
            ? error.message
            : 'The schema could not be registered.',
        )
      }
    } finally {
      setWorking(false)
    }
  }

  const handleExternal = (attestation: SchemaControlAttestation, formatIdentifier: string) => {
    const validation = validateExternalSchema(externalUri, externalIntegrity)
    setFieldErrors(validation.errors)
    if (validation.reference === null) {
      return
    }
    const edit = insertSchemaReference(
      documentTextRef.current,
      attestation.index,
      {
        ...validation.reference,
        formatIdentifier,
      },
      attestation.name,
    )
    if (!edit.ok) {
      setFormError(edit.message)
      return
    }
    replaceDocument(
      edit.text,
      {
        title: 'External schema reference added to the draft.',
        uri: validation.reference.uri,
        integrity: validation.reference.integrity ?? null,
        href: validation.reference.uri,
      },
      `Added the external schema for ${attestation.name} (${formatName(formatIdentifier)}). Save the draft to keep it.`,
    )
  }

  const handleRemove = (attestation: SchemaControlAttestation, formatIdentifier: string) => {
    const edit = removeSchemaReference(documentTextRef.current, attestation.index, formatIdentifier)
    if (!edit.ok) {
      setStatus(edit.message)
      return
    }
    onDocumentChange(edit.text)
    setResult(null)
    setStatus(
      `Removed the schema reference for ${attestation.name} (${formatName(formatIdentifier)}). Save the draft to keep the change.`,
    )
    if (openKey === rowKey(attestation.index, formatIdentifier)) {
      closeForm()
    }
  }

  const renderForm = (attestation: SchemaControlAttestation, formatIdentifier: string) => {
    const key = rowKey(attestation.index, formatIdentifier)
    const formId = `${prefix}-${attestation.index}-${encodeURIComponent(formatIdentifier)}`
    const reference = referenceForFormat(attestation, formatIdentifier)
    const hosted = mode === 'hosted'
    const keyword = credentialTypeKeyword(formatIdentifier)
    const namespaces = preview.ok && keyword === 'docType' ? mdocNamespaces(schemaText) : []
    const missingNamespace = preview.ok && keyword === 'docType' && namespaces.length === 0
    const keywordWarnings = preview.ok ? cborKeywordWarnings(schemaText) : []
    return (
      <div className="schema-form" key={key}>
        <p className="schema-form__title">
          {reference === null ? 'Add a schema for' : 'Replace the schema for'}{' '}
          <strong>{attestation.name}</strong> · <code>{formatName(formatIdentifier)}</code>
        </p>
        <fieldset className="schema-mode">
          <legend>Where should this schema live?</legend>
          <div className="schema-mode__options">
            <label className="schema-mode__option">
              <input
                type="radio"
                name={`${formId}-mode`}
                checked={hosted}
                onChange={() => {
                  setMode('hosted')
                  setFieldErrors({})
                  setFormError(null)
                }}
                disabled={working || disabled}
              />
              <span>
                Upload/paste schema to AttestBook
                <span className="schema-mode__hint">
                  AttestBook stores the exact bytes at a permanent URL and pins them with SHA-256
                  integrity.
                </span>
              </span>
            </label>
            <label className="schema-mode__option">
              <input
                type="radio"
                name={`${formId}-mode`}
                checked={!hosted}
                onChange={() => {
                  setMode('external')
                  setFieldErrors({})
                  setFormError(null)
                }}
                disabled={working || disabled}
              />
              <span>
                Use existing external URL
                <span className="schema-mode__hint">
                  Keep a schema that another issuer or registry already publishes.
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        {hosted ? (
          <div className="schema-form__body" key="hosted">
            <div className="field">
              <label htmlFor={`${formId}-text`}>JSON Schema document</label>
              <textarea
                id={`${formId}-text`}
                className="json-editor schema-form__editor"
                rows={10}
                spellCheck={false}
                value={schemaText}
                onChange={(event) => {
                  applySchemaText(event.target.value, formatIdentifier)
                }}
                disabled={working || disabled}
                aria-describedby={
                  showPreview && !preview.ok
                    ? `${formId}-preview ${formId}-preview-error`
                    : `${formId}-preview`
                }
                aria-invalid={showPreview && !preview.ok}
              />
              <p className="field-hint" id={`${formId}-preview`}>
                JSON Schema 2020-12. The exact text is registered; the API compiles it before it is
                stored.
              </p>
            </div>
            <div className="field">
              <label htmlFor={`${formId}-file`}>Or choose a .json file</label>
              <input
                id={`${formId}-file`}
                type="file"
                accept=".json,application/json,application/schema+json"
                onChange={(event) => {
                  void handleFile(event, formatIdentifier)
                }}
                disabled={working || disabled}
              />
              {fileName === null ? null : <p className="field-hint">Loaded {fileName}.</p>}
            </div>

            <div className="schema-preview" aria-live="polite">
              {showPreview && !preview.ok ? (
                <p className="field-error" id={`${formId}-preview-error`}>
                  {preview.message}
                </p>
              ) : null}
              {showPreview && preview.ok ? (
                <>
                  <p className="schema-preview__status">
                    Valid JSON Schema · {preview.byteLength} bytes
                    {preview.title === null ? null : <> · {preview.title}</>}
                    {preview.dialect === null ? null : (
                      <span className="muted"> · {preview.dialect}</span>
                    )}
                  </p>
                  {keyword !== 'docType' || namespaces.length === 0 ? null : (
                    <p className="schema-preview__status">
                      Namespaces: <code>{namespaces.join(', ')}</code>
                    </p>
                  )}
                  {keywordWarnings.length === 0 ? null : (
                    <Alert variant="warning" title="CBOR values to check" className="schema-lint">
                      <ul>
                        {keywordWarnings.map((warning) => (
                          <li key={`${warning.kind}-${warning.path}`}>
                            <code>{warning.path}</code> <code>{warning.value}</code> is not a
                            supported CBOR{' '}
                            {warning.kind === 'format'
                              ? 'format; use date or date-time'
                              : 'contentEncoding; use base64'}
                            .
                          </li>
                        ))}
                      </ul>
                    </Alert>
                  )}
                  <pre className={CODE_OUTPUT_CLASS} tabIndex={0} aria-label="Schema preview">
                    {schemaText}
                  </pre>
                </>
              ) : null}
              {showPreview ? null : (
                <p className="schema-preview__status">
                  Paste the schema or load a .json file to preview it here.
                </p>
              )}
            </div>

            {keyword === 'docType' ? (
              <Alert variant="info" title="CBOR encoding guidance for mso_mdoc">
                <p>
                  In an mso_mdoc schema, <code>format: "date"</code> maps to CBOR full-date (tag
                  1004) and <code>format: "date-time"</code> to CBOR tdate (tag 0). Use{' '}
                  <code>contentEncoding: "base64"</code> for byte strings. Other format or
                  contentEncoding values are not supported for mdoc credentials.
                </p>
              </Alert>
            ) : null}

            {missingNamespace ? (
              <p className="field-error">
                This mso_mdoc schema declares no namespace. Add a top-level properties member other
                than <code>docType</code> whose subschema is an object schema (
                <code>type: "object"</code> and/or <code>properties</code>) for each namespace.
              </p>
            ) : null}

            {keyword === null ? null : (
              <div className="field">
                <label htmlFor={`${formId}-credential-type`}>
                  {keyword === 'vct' ? 'Credential type (vct)' : 'Document type (docType)'}
                </label>
                <input
                  id={`${formId}-credential-type`}
                  value={credentialType}
                  onChange={(event) => {
                    setCredentialType(event.target.value)
                    setFormError(null)
                  }}
                  placeholder={keyword === 'vct' ? 'urn:eudi:pid:1' : 'eu.europa.ec.eudi.pid.1'}
                  disabled={working || disabled}
                  aria-describedby={`${formId}-credential-type-hint`}
                />
                <p className="field-hint" id={`${formId}-credential-type-hint`}>
                  Optional while drafting; required before publication. The value is written into
                  the schema as <code>properties.{keyword}.const</code> and added to the root{' '}
                  <code>required</code> array. It must match an existing const or enum.
                </p>
              </div>
            )}

            {csrfToken === null ? (
              <p className="field-hint">
                Sign in again before registering; the draft is not changed until the registration
                succeeds.
              </p>
            ) : null}

            <div className="schema-form__actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  void handleRegister(attestation, formatIdentifier)
                }}
                disabled={
                  working || disabled || csrfToken === null || !preview.ok || missingNamespace
                }
                aria-label={`Register and insert schema for ${attestation.name} (${formatName(formatIdentifier)})`}
              >
                {working ? 'Registering…' : 'Register and insert schema'}
              </button>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={closeForm}
                disabled={working}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="schema-form__body" key="external">
            {keyword === null ? null : (
              <Alert variant="info">
                <p>
                  AttestBook cannot inspect an external schema. It must declare{' '}
                  <code>properties.{keyword}.const</code> itself, so publication readiness can only
                  warn that the credential type cannot be verified.
                </p>
              </Alert>
            )}
            <div className="field">
              <label htmlFor={`${formId}-uri`}>Schema URL</label>
              <input
                id={`${formId}-uri`}
                type="url"
                value={externalUri}
                onChange={(event) => {
                  setExternalUri(event.target.value)
                  setFieldErrors((current) => {
                    const next = { ...current }
                    delete next.uri
                    return next
                  })
                  setFormError(null)
                }}
                placeholder="https://issuer.example.org/schemas/pid"
                disabled={working || disabled}
                aria-invalid={fieldErrors.uri !== undefined}
                aria-describedby={
                  fieldErrors.uri === undefined
                    ? `${formId}-uri-hint`
                    : `${formId}-uri-hint ${formId}-uri-error`
                }
              />
              <p className="field-hint" id={`${formId}-uri-hint`}>
                Absolute https URL of a schema the issuer already publishes.
              </p>
              {fieldErrors.uri === undefined ? null : (
                <p className="field-error" id={`${formId}-uri-error`}>
                  {fieldErrors.uri}
                </p>
              )}
            </div>
            <div className="field">
              <label htmlFor={`${formId}-integrity`}>SRI integrity (optional)</label>
              <input
                id={`${formId}-integrity`}
                value={externalIntegrity}
                onChange={(event) => {
                  setExternalIntegrity(event.target.value)
                  setFieldErrors((current) => {
                    const next = { ...current }
                    delete next.integrity
                    return next
                  })
                  setFormError(null)
                }}
                placeholder="sha256-…"
                disabled={working || disabled}
                aria-invalid={fieldErrors.integrity !== undefined}
                aria-describedby={
                  fieldErrors.integrity === undefined
                    ? `${formId}-integrity-hint`
                    : `${formId}-integrity-hint ${formId}-integrity-error`
                }
              />
              <p className="field-hint" id={`${formId}-integrity-hint`}>
                W3C Subresource Integrity pin, such as sha256-&lt;base64&gt;. Leave it empty when
                the source publishes no pin.
              </p>
              {fieldErrors.integrity === undefined ? null : (
                <p className="field-error" id={`${formId}-integrity-error`}>
                  {fieldErrors.integrity}
                </p>
              )}
            </div>
            <div className="schema-form__actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => handleExternal(attestation, formatIdentifier)}
                disabled={working || disabled}
                aria-label={`Insert external reference for ${attestation.name} (${formatName(formatIdentifier)})`}
              >
                Insert external reference
              </button>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={closeForm}
                disabled={working}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {formError === null ? null : (
          <p className="field-error schema-form__error" role="alert">
            {formError}
          </p>
        )}
      </div>
    )
  }

  if (attestation === null) {
    return <p className="field-hint">This attestation is no longer in the draft.</p>
  }

  return (
    <div className="schema-rows">
      {result === null ? null : (
        <Alert variant="success" role="status" title={result.title}>
          <p className="schema-result__value">
            <span className="data">{result.uri}</span>
          </p>
          {result.integrity === null ? null : (
            <p className="schema-result__value">
              Integrity: <span className="data">{result.integrity}</span>
            </p>
          )}
          {result.href === null ? null : (
            <p>
              <a href={result.href} target="_blank" rel="noopener noreferrer">
                Open the schema
              </a>
            </p>
          )}
        </Alert>
      )}

      {status === null ? null : (
        <Alert variant="info" role="status">
          <p>{status}</p>
        </Alert>
      )}

      {attestation.formats.length === 0 ? (
        <p className="field-hint">
          Choose a supported format in the attestation form to attach a schema.
        </p>
      ) : null}

      <div className="schema-attestation">
        {attestation.formats.map((formatIdentifier) => {
          const key = rowKey(attestation.index, formatIdentifier)
          const reference = referenceForFormat(attestation, formatIdentifier)
          const hosted = hostedFor(reference)
          const pinState = hostedIntegrityState({
            integrity: reference?.integrity ?? null,
            hostedSchema: hosted,
          })
          const open = openKey === key
          return (
            <div className="schema-row" key={formatIdentifier}>
              <div className="schema-row__details">
                <p className="schema-row__format">
                  <code>{formatName(formatIdentifier)}</code>
                  {reference === null ? (
                    <span className="schema-row__missing">No schema attached</span>
                  ) : (
                    <span
                      className={`schema-row__source schema-row__source--${hosted === null ? 'external' : 'hosted'}`}
                    >
                      {hosted === null ? 'External URL' : 'Hosted by AttestBook'}
                    </span>
                  )}
                </p>
                {reference === null ? null : (
                  <>
                    <p className="schema-row__uri">
                      <span className="data">{reference.uri}</span>
                    </p>
                    <p className="schema-row__integrity">
                      {reference.integrity === null ? (
                        'No integrity pin'
                      ) : (
                        <span className="data">{reference.integrity}</span>
                      )}
                      {pinState === 'matches' ? (
                        <span className="schema-row__pin schema-row__pin--ok">
                          {' '}
                          · Pin matches stored digest
                        </span>
                      ) : null}
                      {pinState === 'mismatch' ? (
                        <span className="schema-row__pin schema-row__pin--mismatch">
                          {' '}
                          · Pin does not match stored digest
                        </span>
                      ) : null}
                    </p>
                    {hosted === null ? null : (
                      <p className="schema-row__hosted">
                        <span>{kindLabel(hosted.kind)}</span>
                        <span>
                          <code>{hosted.mediaType}</code>
                        </span>
                        <span title={hosted.contentDigest}>
                          SHA-256 <span className="data">{formatDigest(hosted.contentDigest)}</span>
                        </span>
                        <a
                          href={hosted.url}
                          download={hostedSchemaDownloadName(hosted)}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Download the hosted ${kindLabel(hosted.kind)} document for ${attestation.name} (${formatName(formatIdentifier)})`}
                        >
                          Download
                        </a>
                      </p>
                    )}
                  </>
                )}
              </div>
              <div className="schema-row__actions">
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => openForm(attestation, formatIdentifier)}
                  disabled={disabled}
                  aria-expanded={open}
                  aria-label={`${reference === null ? 'Add' : 'Replace'} schema for ${attestation.name} (${formatName(formatIdentifier)})`}
                >
                  {reference === null ? 'Add schema' : 'Replace schema'}
                </button>
                {reference === null ? null : (
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => handleRemove(attestation, formatIdentifier)}
                    disabled={disabled}
                    aria-label={`Remove schema for ${attestation.name} (${formatName(formatIdentifier)})`}
                  >
                    Remove
                  </button>
                )}
              </div>
              {open ? renderForm(attestation, formatIdentifier) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
