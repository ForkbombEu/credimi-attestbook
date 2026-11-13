import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'

import type { EditorApi } from './api'
import { CatalogApiError, isAbortError, isSessionAuthError } from './api'
import { SeverityBadge } from './components/Badges'
import { ErrorState, LoadingState } from './components/CatalogStates'
import { DraftLifecyclePanel } from './components/DraftLifecyclePanel'
import { SiteFooter, SiteHeader, SkipLink } from './components/Layout'
import { SchemaReferenceControls } from './components/SchemaReferenceControls'
import { SessionRenewalForm, SignInRequiredNotice } from './components/SessionPrompt'
import {
  describeDiagnosticPath,
  documentFromDraft,
  draftRequest,
  EMPTY_DRAFT_DOCUMENT,
  EMPTY_METADATA,
  hostedSchemasFromDraft,
  parseDraftDocument,
  serializeDraftDocument,
  validationSummary,
  validateMetadata,
  type DraftMetadata,
} from './draft'
import { AppLink, CATALOG_PATH, rulebookEditorPath, rulebookPath } from './router'
import type { SessionController } from './session'
import type {
  DraftContentDocument,
  DraftRulebook,
  DraftValidationReport,
  HostedSchema,
} from './types'

interface RulebookDraftEditorPageProps {
  readonly api: EditorApi
  /** Empty for a new rulebook; set when editing an existing draft. */
  readonly rulebookId?: string
  /** Administrator session state; writes use its CSRF token, never a bearer. */
  readonly session: SessionController
  readonly onNavigate: (path: string) => void
}

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly draft: DraftRulebook | null }
  | { readonly status: 'not-found' }
  | { readonly status: 'error'; readonly message: string }

const VALIDATION_DEBOUNCE_MS = 350

function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · AttestBook`
  }, [title])
}

function DiagnosticsTable({ report }: { readonly report: DraftValidationReport }) {
  if (report.diagnostics.length === 0) {
    return null
  }
  return (
    <div className="table-wrap table-wrap--nested">
      <table className="detail-table">
        <caption className="sr-only">Live validation findings for the draft</caption>
        <thead>
          <tr>
            <th scope="col">Severity</th>
            <th scope="col">Location</th>
            <th scope="col">Finding</th>
          </tr>
        </thead>
        <tbody>
          {report.diagnostics.map((diagnostic, index) => (
            <tr key={`${diagnostic.code}-${diagnostic.path ?? ''}-${index}`}>
              <td>
                <SeverityBadge severity={diagnostic.severity} />
              </td>
              <td>
                <code>{describeDiagnosticPath(diagnostic.path)}</code>
              </td>
              <td>
                {diagnostic.message} <span className="muted">[{diagnostic.code}]</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function RulebookDraftEditorPage({
  api,
  rulebookId,
  session,
  onNavigate,
}: RulebookDraftEditorPageProps) {
  const creating = rulebookId === undefined
  const fieldId = useId()
  const fieldPrefix = `editor-${fieldId.replaceAll(':', '')}`

  const [state, setState] = useState<LoadState>(
    creating ? { status: 'ready', draft: null } : { status: 'loading' },
  )
  const [reloadToken, setReloadToken] = useState(0)
  const [metadata, setMetadata] = useState<DraftMetadata>(EMPTY_METADATA)
  const [jsonText, setJsonText] = useState(() =>
    serializeDraftDocument({ attestations: [], schemaReferences: [] }),
  )
  const [validation, setValidation] = useState<DraftValidationReport | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [validating, setValidating] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [sessionSeen, setSessionSeen] = useState(session.status === 'authenticated')
  const [dirty, setDirty] = useState(false)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [renewedNotice, setRenewedNotice] = useState<string | null>(null)
  const [hostedSchemas, setHostedSchemas] = useState<ReadonlyMap<string, HostedSchema>>(new Map())
  const pendingValidation = useRef<AbortController | null>(null)

  const loadDraft = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      if (rulebookId === undefined) {
        return
      }
      const draft = await api.getDraft(rulebookId, signal)
      if (signal.aborted) {
        return
      }
      setMetadata({
        name: draft.name,
        description: draft.description,
        sourceUrl: draft.sourceUrl ?? '',
        applicableSpec: draft.applicableSpec,
      })
      setJsonText(serializeDraftDocument(documentFromDraft(draft)))
      setHostedSchemas(hostedSchemasFromDraft(draft))
      setState({ status: 'ready', draft })
    },
    [api, rulebookId],
  )

  useEffect(() => {
    if (session.status === 'authenticated') {
      setSessionSeen(true)
    }
  }, [session.status])

  useEffect(() => {
    // The protected view does not read or render a draft before the first
    // authenticated session. Latching that fact (rather than depending on the
    // current status) means signing out and back in for an expired session
    // never re-fetches and overwrites the unsaved working copy.
    if (!sessionSeen) {
      return
    }
    if (rulebookId === undefined) {
      setState({ status: 'ready', draft: null })
      return
    }
    const controller = new AbortController()
    setState({ status: 'loading' })
    loadDraft(controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted) {
        return
      }
      if (error instanceof CatalogApiError && error.status === 404) {
        setState({ status: 'not-found' })
        return
      }
      setState({
        status: 'error',
        message:
          error instanceof Error && error.message !== ''
            ? error.message
            : 'The draft request failed.',
      })
    })
    return () => controller.abort()
  }, [loadDraft, reloadToken, rulebookId, sessionSeen])

  const draft = state.status === 'ready' ? state.draft : null
  const readOnly = draft !== null && draft.publicationStatus !== 'draft'
  const title = creating ? 'New rulebook draft' : 'Rulebook draft editor'
  useDocumentTitle(title)

  const authenticated = session.status === 'authenticated'
  const csrfToken = authenticated ? (session.session?.csrfToken ?? null) : null
  /** Keep an unsaved form mounted across an expiry or a sign-out. */
  const keepUnsavedForm = dirty || sessionExpired
  const needsSignIn = !authenticated

  const parsed = useMemo(() => parseDraftDocument(jsonText), [jsonText])
  const metadataErrors = useMemo(() => validateMetadata(metadata), [metadata])
  const parseError = parsed.ok ? null : parsed.message
  // Keep the last readable attestation list while the raw JSON is temporarily
  // invalid, so the schema controls stay visible (disabled) rather than
  // disappearing as the user fixes a syntax error.
  const [lastParsedDocument, setLastParsedDocument] =
    useState<DraftContentDocument>(EMPTY_DRAFT_DOCUMENT)
  useEffect(() => {
    if (parsed.ok) {
      setLastParsedDocument(parsed.document)
    }
  }, [parsed])

  useEffect(() => {
    if (state.status !== 'ready' || readOnly) {
      return
    }
    pendingValidation.current?.abort()
    if (!parsed.ok) {
      setValidation(null)
      setValidationError(null)
      setValidating(false)
      return
    }
    const controller = new AbortController()
    pendingValidation.current = controller
    const timer = setTimeout(() => {
      setValidating(true)
      api
        .validateDraft(draftRequest(metadata, parsed.document), controller.signal)
        .then((report) => {
          if (controller.signal.aborted) {
            return
          }
          setValidation(report)
          setValidationError(null)
          setValidating(false)
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || isAbortError(error)) {
            return
          }
          setValidation(null)
          setValidating(false)
          setValidationError(
            error instanceof Error && error.message !== ''
              ? error.message
              : 'Live validation failed.',
          )
        })
    }, VALIDATION_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [api, metadata, parsed, readOnly, state.status])

  useEffect(() => () => pendingValidation.current?.abort(), [])

  const updateMetadata = (field: keyof DraftMetadata, value: string) => {
    setMetadata((current) => ({ ...current, [field]: value }))
    setDirty(true)
    setSavedAt(null)
    setSaveError(null)
  }

  /**
   * The schema controls build over the raw Draft JSON, so an insertion is an
   * ordinary unsaved edit: it marks the form dirty and clears the saved marker.
   */
  const handleSchemaDocumentChange = useCallback((text: string) => {
    setJsonText(text)
    setDirty(true)
    setSavedAt(null)
    setSaveError(null)
    setFormError(null)
  }, [])

  const reload = useCallback(() => setReloadToken((value) => value + 1), [])

  /**
   * Applies the status a lifecycle transition produced without re-fetching the
   * working copy, so the transition's own result stays visible.
   */
  const handleLifecycleChange = useCallback(
    (publicationStatus: DraftRulebook['publicationStatus']) => {
      setState((current) =>
        current.status === 'ready' && current.draft !== null
          ? { status: 'ready', draft: { ...current.draft, publicationStatus } }
          : current,
      )
    },
    [],
  )

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaveError(null)
    setSavedAt(null)

    const current = parseDraftDocument(jsonText)
    if (!current.ok) {
      setFormError(current.message)
      return
    }
    const errors = validateMetadata(metadata)
    if (Object.keys(errors).length > 0) {
      setFormError('Fix the highlighted metadata fields before saving.')
      return
    }
    setFormError(null)
    if (readOnly) {
      setSaveError('Only a draft rulebook can be edited.')
      return
    }
    if (csrfToken === null) {
      setSessionExpired(true)
      setSaveError('Sign in again to save this draft; your edits stay on this page.')
      return
    }
    if (validation !== null && !validation.saveable) {
      setSaveError('Fix the structural errors before saving the draft.')
      return
    }

    const request = draftRequest(metadata, current.document)
    setSaving(true)
    try {
      if (creating) {
        const created = await api.createDraft(request, csrfToken)
        onNavigate(rulebookEditorPath(created.id))
        return
      }
      const saved = await api.replaceDraft(rulebookId, request, csrfToken)
      setState({ status: 'ready', draft: saved })
      setHostedSchemas(hostedSchemasFromDraft(saved))
      setDirty(false)
      setSessionExpired(false)
      setRenewedNotice(null)
      setSavedAt(new Date().toISOString())
    } catch (error) {
      if (isSessionAuthError(error)) {
        setSessionExpired(true)
        setRenewedNotice(null)
      }
      setSaveError(
        error instanceof Error && error.message !== ''
          ? error.message
          : 'The draft could not be saved.',
      )
    } finally {
      setSaving(false)
    }
  }

  const nameForHeading = metadata.name.trim() === '' ? 'Untitled rulebook' : metadata.name
  const summary = readOnly
    ? 'Read-only: published rulebooks cannot be edited or validated here.'
    : validating
      ? 'Validating…'
      : validation === null
        ? parseError === null
          ? 'Waiting for validation…'
          : 'Fix the JSON before validation can run.'
        : validationSummary(validation.diagnostics)
  const canSave =
    authenticated &&
    !readOnly &&
    !saving &&
    parseError === null &&
    Object.keys(metadataErrors).length === 0 &&
    (validation === null || validation.saveable)

  if (session.status === 'loading' && !keepUnsavedForm) {
    return (
      <div className="app-shell">
        <SkipLink href="#main-content">Skip to the draft editor</SkipLink>
        <SiteHeader section="Rulebook editor" onNavigate={onNavigate} />
        <main className="page" id="main-content">
          <LoadingState
            title="Checking your administrator session…"
            detail="The editor needs a signed-in administrator."
          />
        </main>
        <SiteFooter />
      </div>
    )
  }

  if (needsSignIn && !keepUnsavedForm) {
    return (
      <div className="app-shell">
        <SkipLink href="#main-content">Skip to the draft editor</SkipLink>
        <SiteHeader section="Rulebook editor" onNavigate={onNavigate} />
        <main className="page" id="main-content">
          <SignInRequiredNotice
            title="Sign in to author rulebooks"
            message="Creating and editing a rulebook needs the configured administrator session. The catalogue, rulebook details and the validation playground stay available without signing in."
            onNavigate={onNavigate}
          />
        </main>
        <SiteFooter />
      </div>
    )
  }

  if (state.status === 'loading') {
    return (
      <div className="app-shell">
        <SkipLink href="#main-content">Skip to the draft editor</SkipLink>
        <SiteHeader section="Rulebook editor" onNavigate={onNavigate} />
        <main className="page" id="main-content">
          <LoadingState title="Loading the draft…" detail="Reading the draft working copy." />
        </main>
        <SiteFooter />
      </div>
    )
  }

  if (state.status === 'not-found') {
    return (
      <div className="app-shell">
        <SiteHeader section="Rulebook editor" onNavigate={onNavigate} />
        <main className="page" id="main-content">
          <div className="state-panel state-panel--empty" role="alert">
            <h1 className="state-title">Rulebook not found</h1>
            <p className="state-detail">No rulebook matches this address.</p>
            <button
              type="button"
              className="button button--primary"
              onClick={() => onNavigate(CATALOG_PATH)}
            >
              Back to the catalog
            </button>
          </div>
        </main>
        <SiteFooter />
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="app-shell">
        <SiteHeader section="Rulebook editor" onNavigate={onNavigate} />
        <main className="page" id="main-content">
          <ErrorState
            title="The draft could not be loaded."
            message={state.message}
            onRetry={reload}
          />
        </main>
        <SiteFooter />
      </div>
    )
  }

  return (
    <div className="app-shell">
      <SkipLink href="#draft-editor">Skip to the draft editor</SkipLink>
      <SiteHeader section="Rulebook editor" onNavigate={onNavigate} />
      <main className="page" id="main-content">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <ol>
            <li>
              <AppLink href={CATALOG_PATH} onNavigate={onNavigate}>
                Rulebook catalog
              </AppLink>
            </li>
            {rulebookId === undefined ? null : (
              <li>
                <AppLink href={rulebookPath(rulebookId)} onNavigate={onNavigate}>
                  {nameForHeading}
                </AppLink>
              </li>
            )}
            <li aria-current="page">{creating ? 'New rulebook' : 'Edit draft'}</li>
          </ol>
        </nav>

        <div className="page-heading">
          <p className="eyebrow">{creating ? 'Authoring' : 'Draft working copy'}</p>
          <h1>{creating ? 'New rulebook draft' : `Edit ${nameForHeading} draft`}</h1>
          <p className="lede">
            Edit the rulebook metadata and its attestation JSON. Validation runs as you type; saving
            a draft never changes a frozen or published version.
          </p>
        </div>

        <div id="draft-editor" tabIndex={-1}>
          {readOnly ? (
            <div className="notice notice--warning" role="status">
              <p className="notice-title">This rulebook is {draft?.publicationStatus}.</p>
              Only its draft working copy can be edited. Create a new draft version from the
              lifecycle workflow before changing content.
            </div>
          ) : null}

          {formError === null ? null : (
            <div className="state-panel state-panel--error playground-error-summary" role="alert">
              <h2 className="state-title">The draft cannot be saved</h2>
              <p>{formError}</p>
            </div>
          )}

          {sessionExpired || (needsSignIn && keepUnsavedForm) ? (
            <SessionRenewalForm
              session={session}
              onRenewed={() => {
                setSessionExpired(false)
                setRenewedNotice(
                  'Signed in again. Your edits are preserved; save the draft to store them.',
                )
              }}
            />
          ) : null}
          {renewedNotice === null ? null : (
            <p className="notice" role="status">
              {renewedNotice}
            </p>
          )}

          <form onSubmit={handleSubmit} noValidate>
            <section className="detail-card" aria-labelledby={`${fieldPrefix}-metadata-heading`}>
              <h2 id={`${fieldPrefix}-metadata-heading`}>Rulebook metadata</h2>
              <div className="editor-grid">
                <div className="field">
                  <label htmlFor={`${fieldPrefix}-name`}>Name</label>
                  <input
                    id={`${fieldPrefix}-name`}
                    value={metadata.name}
                    onChange={(event) => updateMetadata('name', event.target.value)}
                    required
                    disabled={readOnly}
                    aria-invalid={metadataErrors.name !== undefined}
                    aria-describedby={
                      metadataErrors.name === undefined ? undefined : `${fieldPrefix}-name-error`
                    }
                  />
                  {metadataErrors.name === undefined ? null : (
                    <p className="field-error" id={`${fieldPrefix}-name-error`}>
                      {metadataErrors.name}
                    </p>
                  )}
                </div>
                <div className="field">
                  <label htmlFor={`${fieldPrefix}-spec`}>Applicable specification</label>
                  <input
                    id={`${fieldPrefix}-spec`}
                    value={metadata.applicableSpec}
                    onChange={(event) => updateMetadata('applicableSpec', event.target.value)}
                    required
                    disabled={readOnly}
                    aria-invalid={metadataErrors.applicableSpec !== undefined}
                    aria-describedby={
                      metadataErrors.applicableSpec === undefined
                        ? undefined
                        : `${fieldPrefix}-spec-error`
                    }
                  />
                  {metadataErrors.applicableSpec === undefined ? null : (
                    <p className="field-error" id={`${fieldPrefix}-spec-error`}>
                      {metadataErrors.applicableSpec}
                    </p>
                  )}
                  <p className="field-hint">
                    The live standards checks cover the TS11 v1.0.1 baseline; other profiles are
                    checked structurally only.
                  </p>
                </div>
                <div className="field editor-grid__wide">
                  <label htmlFor={`${fieldPrefix}-source`}>Source URL (optional)</label>
                  <input
                    id={`${fieldPrefix}-source`}
                    type="url"
                    value={metadata.sourceUrl}
                    onChange={(event) => updateMetadata('sourceUrl', event.target.value)}
                    disabled={readOnly}
                    placeholder="https://issuer.example.org/rulebooks/pid"
                  />
                  <p className="field-hint">
                    Provenance of the authored rulebook; it is not injected into the standards
                    document.
                  </p>
                </div>
                <div className="field editor-grid__wide">
                  <label htmlFor={`${fieldPrefix}-description`}>Description</label>
                  <textarea
                    id={`${fieldPrefix}-description`}
                    rows={3}
                    value={metadata.description}
                    onChange={(event) => updateMetadata('description', event.target.value)}
                    disabled={readOnly}
                  />
                </div>
              </div>
            </section>

            <section className="detail-card" aria-labelledby={`${fieldPrefix}-json-heading`}>
              <h2 id={`${fieldPrefix}-json-heading`}>Attestations and schema references</h2>
              <p className="field-hint">
                JSON object with an <code>attestations</code> array and a rulebook-level{' '}
                <code>schemaReferences</code> array. Each attestation type carries its level of
                assurance, binding type, supported formats and schema references.
              </p>
              <div className="field field--credential">
                <label htmlFor={`${fieldPrefix}-json`}>Draft JSON</label>
                <textarea
                  id={`${fieldPrefix}-json`}
                  className="json-editor"
                  spellCheck={false}
                  rows={24}
                  value={jsonText}
                  onChange={(event) => {
                    setJsonText(event.target.value)
                    setDirty(true)
                    setSavedAt(null)
                    setSaveError(null)
                  }}
                  disabled={readOnly}
                  aria-invalid={parseError !== null}
                  aria-describedby={
                    parseError === null
                      ? `${fieldPrefix}-json-hint`
                      : `${fieldPrefix}-json-hint ${fieldPrefix}-json-error`
                  }
                />
                <p className="field-hint" id={`${fieldPrefix}-json-hint`}>
                  Structural errors block a save; standards findings are reported but do not block a
                  work-in-progress draft.
                </p>
                {parseError === null ? null : (
                  <p className="field-error" id={`${fieldPrefix}-json-error`}>
                    {parseError}
                  </p>
                )}
              </div>
            </section>

            <SchemaReferenceControls
              api={api}
              document={parsed.ok ? parsed.document : lastParsedDocument}
              documentText={jsonText}
              disabled={readOnly || !parsed.ok}
              disabledReason={
                readOnly
                  ? null
                  : parsed.ok
                    ? null
                    : 'Fix the Draft JSON before editing schema references.'
              }
              csrfToken={csrfToken}
              hostedSchemas={hostedSchemas}
              onDocumentChange={handleSchemaDocumentChange}
              onSessionExpired={() => {
                setSessionExpired(true)
                setRenewedNotice(null)
              }}
            />

            <section className="detail-card" aria-labelledby={`${fieldPrefix}-validation-heading`}>
              <h2 id={`${fieldPrefix}-validation-heading`}>Live validation</h2>
              <p className="editor-status" role="status" aria-live="polite">
                {summary}
                {validation?.profile === null ? ' Standards checks did not run.' : null}
              </p>
              {validationError === null ? null : (
                <div
                  className="state-panel state-panel--error playground-error-summary"
                  role="alert"
                >
                  <p className="state-title">Live validation failed</p>
                  <p>{validationError}</p>
                </div>
              )}
              {validation === null ? null : (
                <>
                  <DiagnosticsTable report={validation} />
                  {validation.limitations.length === 0 ? null : (
                    <div className="editor-limitations">
                      <h3>Validation boundaries</h3>
                      <ul className="limitation-list">
                        {validation.limitations.map((limitation) => (
                          <li key={limitation}>{limitation}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </section>

            {saveError === null ? null : (
              <div className="state-panel state-panel--error playground-error-summary" role="alert">
                <h2 className="state-title">The draft was not saved</h2>
                <p>{saveError}</p>
              </div>
            )}
            {savedAt === null ? null : (
              <p className="notice editor-saved" role="status">
                Draft saved at {new Date(savedAt).toLocaleTimeString()}. Frozen and published
                versions were not changed.
              </p>
            )}

            <div className="editor-actions">
              <button type="submit" className="button button--primary" disabled={!canSave}>
                {saving ? 'Saving…' : creating ? 'Create draft' : 'Save draft'}
              </button>
              <AppLink
                href={rulebookId === undefined ? CATALOG_PATH : rulebookPath(rulebookId)}
                onNavigate={onNavigate}
                className="button button--ghost"
              >
                Cancel
              </AppLink>
            </div>
          </form>

          {rulebookId === undefined || draft === null ? null : (
            <DraftLifecyclePanel
              api={api}
              rulebookId={rulebookId}
              csrfToken={csrfToken}
              publicationStatus={draft.publicationStatus}
              onChanged={handleLifecycleChange}
              onSessionExpired={() => {
                setSessionExpired(true)
                setRenewedNotice(null)
              }}
            />
          )}
        </div>
      </main>
      <SiteFooter />
    </div>
  )
}
