// Per-attestation schema-reference controls for the draft editor (issue #100).
//
// The component is a builder over the existing Draft JSON, not a second source
// of truth: every insert or removal transforms the JSON text the page owns.
// Hosted documents are registered through the administrator session and its
// CSRF token, then the API's canonical URI and SRI pin become ordinary
// `schemaReferences` values. External references are entered directly.

import { useId, useMemo, useState, type ChangeEvent } from 'react'

import { isSessionAuthError, type EditorApi } from '../api'
import {
  HOSTED_SCHEMA_KIND,
  MAX_HOSTED_SCHEMA_BYTES,
  insertSchemaReference,
  previewHostedSchema,
  referenceForFormat,
  removeSchemaReference,
  schemaControlAttestations,
  validateExternalSchema,
  type SchemaControlAttestation,
} from '../schema-reference'
import type { DraftContentDocument, DraftSchemaReference } from '../types'

type SchemaSource = 'hosted' | 'external'

interface SchemaReferenceControlsProps {
  readonly document: DraftContentDocument
  readonly documentText: string
  readonly disabled: boolean
  /** Why the controls are disabled, when the reason is not simply read-only. */
  readonly disabledReason: string | null
  /** Null means the administrator session cannot authorize a registration. */
  readonly csrfToken: string | null
  readonly api: EditorApi
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

/** A hosted reference is recognised by the AttestBook document path. */
function isHostedReference(reference: DraftSchemaReference): boolean {
  try {
    const url = new URL(reference.uri, window.location.origin)
    return url.pathname.startsWith('/api/v1/schema-documents/')
  } catch {
    return false
  }
}

function defaultMode(reference: DraftSchemaReference | null): SchemaSource {
  if (reference === null) {
    return 'hosted'
  }
  return isHostedReference(reference) ? 'hosted' : 'external'
}

function formatName(formatIdentifier: string): string {
  return formatIdentifier === '' ? 'unknown format' : formatIdentifier
}

export function SchemaReferenceControls({
  document,
  documentText,
  disabled,
  disabledReason,
  csrfToken,
  api,
  onDocumentChange,
  onSessionExpired,
}: SchemaReferenceControlsProps) {
  const fieldId = useId()
  const prefix = `schema-${fieldId.replaceAll(':', '')}`
  const attestations = useMemo(() => schemaControlAttestations(document), [document])

  const [openKey, setOpenKey] = useState<string | null>(null)
  const [mode, setMode] = useState<SchemaSource>('hosted')
  const [schemaText, setSchemaText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [externalUri, setExternalUri] = useState('')
  const [externalIntegrity, setExternalIntegrity] = useState('')
  const [fieldErrors, setFieldErrors] = useState<{
    readonly uri?: string
    readonly integrity?: string
  }>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [result, setResult] = useState<ResultNotice | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const preview = useMemo(() => previewHostedSchema(schemaText), [schemaText])
  const showPreview = schemaText.trim() !== ''

  const resetForm = () => {
    setSchemaText('')
    setFileName(null)
    setExternalUri('')
    setExternalIntegrity('')
    setFieldErrors({})
    setFormError(null)
  }

  const openForm = (attestation: SchemaControlAttestation, formatIdentifier: string) => {
    const reference = referenceForFormat(attestation, formatIdentifier)
    setOpenKey(rowKey(attestation.index, formatIdentifier))
    setMode(defaultMode(reference))
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

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
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
      const text = await file.text()
      setSchemaText(text)
      setFileName(file.name)
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
    if (csrfToken === null) {
      onSessionExpired()
      setFormError('Sign in again to register this schema with your administrator session.')
      return
    }
    setWorking(true)
    setFormError(null)
    try {
      const registered = await api.registerSchemaDocument(HOSTED_SCHEMA_KIND, schemaText, csrfToken)
      const edit = insertSchemaReference(documentText, attestation.index, {
        formatIdentifier,
        uri: registered.url,
        integrity: registered.integrity,
      })
      if (!edit.ok) {
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
    const edit = insertSchemaReference(documentText, attestation.index, {
      ...validation.reference,
      formatIdentifier,
    })
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
    const edit = removeSchemaReference(documentText, attestation.index, formatIdentifier)
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
                  setSchemaText(event.target.value)
                  setFileName(null)
                  setFormError(null)
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
                  void handleFile(event)
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
                  <pre className="schema-preview__text" tabIndex={0} aria-label="Schema preview">
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

            {csrfToken === null ? (
              <p className="field-hint">
                Sign in again before registering; the draft JSON is not changed until the
                registration succeeds.
              </p>
            ) : null}

            <div className="schema-form__actions">
              <button
                type="button"
                className="button button--primary button--small"
                onClick={() => {
                  void handleRegister(attestation, formatIdentifier)
                }}
                disabled={working || disabled || csrfToken === null || !preview.ok}
                aria-label={`Register and insert schema for ${attestation.name} (${formatName(formatIdentifier)})`}
              >
                {working ? 'Registering…' : 'Register and insert schema'}
              </button>
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={closeForm}
                disabled={working}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="schema-form__body" key="external">
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
                className="button button--primary button--small"
                onClick={() => handleExternal(attestation, formatIdentifier)}
                disabled={working || disabled}
                aria-label={`Insert external reference for ${attestation.name} (${formatName(formatIdentifier)})`}
              >
                Insert external reference
              </button>
              <button
                type="button"
                className="button button--ghost button--small"
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

  return (
    <section className="detail-card" aria-labelledby={`${prefix}-heading`}>
      <h2 id={`${prefix}-heading`}>Schema references</h2>
      <p className="field-hint schema-reference-intro">
        Add one schema reference per attestation format. The controls update the Draft JSON above;
        the raw editor stays the source of truth.
      </p>

      {disabled && disabledReason === null ? (
        <p className="field-hint">
          Read-only: schema references can be changed only while the rulebook is a draft.
        </p>
      ) : null}
      {disabledReason === null ? null : <p className="field-hint">{disabledReason}</p>}

      {result === null ? null : (
        <div className="notice schema-result" role="status">
          <p className="notice-title">{result.title}</p>
          <p className="schema-result__value">
            <code>{result.uri}</code>
          </p>
          {result.integrity === null ? null : (
            <p className="schema-result__value">
              Integrity: <code>{result.integrity}</code>
            </p>
          )}
          {result.href === null ? null : (
            <p>
              <a href={result.href} target="_blank" rel="noopener noreferrer">
                Open the schema
              </a>
            </p>
          )}
        </div>
      )}

      {status === null ? null : (
        <p className="notice schema-status" role="status">
          {status}
        </p>
      )}

      {attestations.length === 0 ? (
        <p className="field-hint">
          Add an attestation to the Draft JSON first; schema references attach to an attestation
          type and one of its supported formats.
        </p>
      ) : null}

      <div className="schema-attestations">
        {attestations.map((attestation) => (
          <div className="schema-attestation" key={attestation.index}>
            <h3 className="schema-attestation__title">
              {attestation.name}
              <span className="schema-attestation__position">
                Attestation {attestation.index + 1}
              </span>
            </h3>
            {attestation.formats.length === 0 ? (
              <p className="field-hint">
                Add a supported format for this attestation in the Draft JSON to attach a schema.
              </p>
            ) : null}
            {attestation.formats.map((formatIdentifier) => {
              const key = rowKey(attestation.index, formatIdentifier)
              const reference = referenceForFormat(attestation, formatIdentifier)
              const open = openKey === key
              return (
                <div className="schema-row" key={formatIdentifier}>
                  <div className="schema-row__details">
                    <p className="schema-row__format">
                      <code>{formatName(formatIdentifier)}</code>
                      {reference === null ? (
                        <span className="schema-row__missing">No schema attached</span>
                      ) : (
                        <span className="schema-row__source">
                          {isHostedReference(reference) ? 'AttestBook-hosted' : 'External'}
                        </span>
                      )}
                    </p>
                    {reference === null ? null : (
                      <>
                        <p className="schema-row__uri">
                          <code>{reference.uri}</code>
                        </p>
                        <p className="schema-row__integrity">
                          {reference.integrity === null ? (
                            'No integrity pin'
                          ) : (
                            <code>{reference.integrity}</code>
                          )}
                        </p>
                      </>
                    )}
                  </div>
                  <div className="schema-row__actions">
                    <button
                      type="button"
                      className="button button--ghost button--small"
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
                        className="button button--ghost button--small"
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
        ))}
      </div>
    </section>
  )
}
