import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'

import type { EditorApi } from './api'
import { CatalogApiError, isAbortError, isSessionAuthError } from './api'
import { Alert } from './components/Alert'
import { AttestationTypesSection } from './components/AttestationTypesSection'
import { SeverityBadge } from './components/Badges'
import { ErrorState, LoadingState } from './components/CatalogStates'
import { CreateVersionPanel } from './components/CreateVersionPanel'
import { DraftLifecyclePanel } from './components/DraftLifecyclePanel'
import { GuideLink } from './components/GuideLink'
import { PageHero, SiteFooter, SiteHeader, SkipLink } from './components/Layout'
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
  RulebookVersion,
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
  const [nextVersionNotice, setNextVersionNotice] = useState<string | null>(null)
  const [versionsRefreshToken, setVersionsRefreshToken] = useState(0)
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
  // Only the administrator bound to the owning provider is offered the
  // next-version transition; the server independently enforces the same rule.
  const ownsRulebook =
    draft !== null &&
    session.status === 'authenticated' &&
    session.session !== null &&
    session.session.provider.id === draft.providerId
  const creatingNextVersion =
    draft !== null && draft.publicationStatus === 'published' && ownsRulebook
  const title = creating
    ? 'New rulebook draft'
    : creatingNextVersion
      ? 'Create a new version'
      : 'Rulebook draft editor'
  useDocumentTitle(title)

  const authenticated = session.status === 'authenticated'
  const csrfToken = authenticated ? (session.session?.csrfToken ?? null) : null
  /** Keep an unsaved form mounted across an expiry or a sign-out. */
  const keepUnsavedForm = dirty || sessionExpired
  const needsSignIn = !authenticated

  const parsed = useMemo(() => parseDraftDocument(jsonText), [jsonText])
  const metadataErrors = useMemo(() => validateMetadata(metadata), [metadata])
  const parseError = parsed.ok ? null : parsed.message
  // Keep the last readable attestation list while the serialized document is
  // temporarily unreadable, so the form stays visible (disabled) rather than
  // disappearing.
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
   * The attestation section builds over the serialized draft document, so an
   * edit is an ordinary unsaved change: it marks the form dirty and clears the
   * saved marker.
   */
  const handleDocumentChange = useCallback((text: string) => {
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
      // A creation notice is only meaningful while the working copy stays
      // editable; publishing its draft version replaces that state.
      if (publicationStatus !== 'draft') {
        setNextVersionNotice(null)
      }
    },
    [],
  )

  /**
   * The next-version flow reopened the working copy: the editor becomes
   * editable in place, the now-historical published artifact is untouched, and
   * the lifecycle panel reloads to offer refresh, readiness and publish for the
   * new draft version.
   */
  const handleVersionCreated = useCallback(
    (created: RulebookVersion) => {
      handleLifecycleChange('draft')
      setNextVersionNotice(
        `Draft version ${created.version} created. The working copy is now editable; the previously published version keeps its bytes and digest.`,
      )
      setVersionsRefreshToken((token) => token + 1)
    },
    [handleLifecycleChange],
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
          : 'The draft document could not be read before validation could run.'
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
        <main className="page-main" id="main-content">
          <PageHero title="Rulebook editor" />
          <div className="page">
            <LoadingState
              title="Checking your administrator session…"
              detail="The editor needs a signed-in administrator."
            />
          </div>
        </main>
        <SiteFooter onNavigate={onNavigate} />
      </div>
    )
  }

  if (needsSignIn && !keepUnsavedForm) {
    return (
      <div className="app-shell">
        <SkipLink href="#main-content">Skip to the draft editor</SkipLink>
        <SiteHeader section="Rulebook editor" onNavigate={onNavigate} />
        <main className="page-main" id="main-content">
          <SignInRequiredNotice
            title="Sign in to author rulebooks"
            message="Creating and editing a rulebook needs the configured administrator session. The catalogue, rulebook details and the validation playground stay available without signing in."
            onNavigate={onNavigate}
          />
        </main>
        <SiteFooter onNavigate={onNavigate} />
      </div>
    )
  }

  if (state.status === 'loading') {
    return (
      <div className="app-shell">
        <SkipLink href="#main-content">Skip to the draft editor</SkipLink>
        <SiteHeader section="Rulebook editor" onNavigate={onNavigate} />
        <main className="page-main" id="main-content">
          <PageHero title="Rulebook editor" />
          <div className="page">
            <LoadingState title="Loading the draft…" detail="Reading the draft working copy." />
          </div>
        </main>
        <SiteFooter onNavigate={onNavigate} />
      </div>
    )
  }

  if (state.status === 'not-found') {
    return (
      <div className="app-shell">
        <SiteHeader section="Rulebook editor" onNavigate={onNavigate} />
        <main className="page-main" id="main-content">
          <PageHero title="Rulebook not found" alert>
            <p>No rulebook matches this address.</p>
            <p className="hero-actions">
              <button
                type="button"
                className="btn btn-outline btn-lg"
                onClick={() => onNavigate(CATALOG_PATH)}
              >
                Back to the catalog
              </button>
            </p>
          </PageHero>
        </main>
        <SiteFooter onNavigate={onNavigate} />
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="app-shell">
        <SiteHeader section="Rulebook editor" onNavigate={onNavigate} />
        <main className="page-main" id="main-content">
          <PageHero title="Rulebook editor" />
          <div className="page">
            <ErrorState
              title="The draft could not be loaded."
              message={state.message}
              onRetry={reload}
            />
          </div>
        </main>
        <SiteFooter onNavigate={onNavigate} />
      </div>
    )
  }

  return (
    <div className="app-shell">
      <SkipLink href="#draft-editor">Skip to the draft editor</SkipLink>
      <SiteHeader section="Rulebook editor" onNavigate={onNavigate} />
      <main className="page-main" id="main-content">
        <PageHero
          title={
            creating
              ? 'New rulebook draft'
              : creatingNextVersion
                ? `Create a new version of ${nameForHeading}`
                : `Edit ${nameForHeading} draft`
          }
        >
          <p>
            {creatingNextVersion
              ? 'This rulebook is published and immutable. Create a new draft version to reopen the working copy for editing; the published artifact is not changed.'
              : 'Edit the rulebook metadata, its attestation types and their schemas. Validation runs as you type; saving a draft never changes a frozen or published version.'}
          </p>
          <p className="page-help">
            New to rulebook authoring? Read the{' '}
            <GuideLink slug="rulebook-authoring">rulebook authoring guide</GuideLink>.
          </p>
        </PageHero>

        <div className="page" id="draft-editor" tabIndex={-1}>
          {rulebookId === undefined || !creatingNextVersion ? null : (
            <CreateVersionPanel
              api={api}
              rulebookId={rulebookId}
              csrfToken={csrfToken}
              onCreated={handleVersionCreated}
              onSessionExpired={() => {
                setSessionExpired(true)
                setRenewedNotice(null)
              }}
            />
          )}

          {nextVersionNotice === null ? null : (
            <Alert variant="success" role="status">
              <p>{nextVersionNotice}</p>
            </Alert>
          )}

          {readOnly ? (
            <Alert
              variant="warning"
              role="status"
              title={`This rulebook is ${draft?.publicationStatus}.`}
            >
              <p>
                {creatingNextVersion
                  ? 'The form below is read-only until you create the new version. The published bytes and digest are not changed by this flow.'
                  : draft?.publicationStatus === 'published'
                    ? 'Only its draft working copy can be edited; creating a new version needs the administrator of the provider that owns this rulebook.'
                    : 'Only its draft working copy can be edited. A historical rulebook cannot be transitioned again.'}
              </p>
            </Alert>
          ) : null}

          {formError === null ? null : (
            <Alert
              variant="destructive"
              role="alert"
              title="The draft cannot be saved"
              titleAs="h2"
            >
              <p>{formError}</p>
            </Alert>
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
            <Alert variant="info" role="status">
              <p>{renewedNotice}</p>
            </Alert>
          )}

          <form onSubmit={handleSubmit} noValidate>
            <section
              className="content-section"
              aria-labelledby={`${fieldPrefix}-metadata-heading`}
            >
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

            <AttestationTypesSection
              api={api}
              document={parsed.ok ? parsed.document : lastParsedDocument}
              documentText={jsonText}
              disabled={readOnly || !parsed.ok}
              csrfToken={csrfToken}
              hostedSchemas={hostedSchemas}
              onDocumentChange={handleDocumentChange}
              onSessionExpired={() => {
                setSessionExpired(true)
                setRenewedNotice(null)
              }}
            />

            <section
              className="content-section"
              aria-labelledby={`${fieldPrefix}-validation-heading`}
            >
              <h2 id={`${fieldPrefix}-validation-heading`}>Live validation</h2>
              <p className="editor-status" role="status" aria-live="polite">
                {summary}
                {validation?.profile === null ? ' Standards checks did not run.' : null}
              </p>
              {validationError === null ? null : (
                <Alert variant="destructive" role="alert" title="Live validation failed">
                  <p>{validationError}</p>
                </Alert>
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
              <Alert
                variant="destructive"
                role="alert"
                title="The draft was not saved"
                titleAs="h2"
              >
                <p>{saveError}</p>
              </Alert>
            )}
            {savedAt === null ? null : (
              <Alert variant="success" role="status">
                <p>
                  Draft saved at {new Date(savedAt).toLocaleTimeString()}. Frozen and published
                  versions were not changed.
                </p>
              </Alert>
            )}

            <div className="editor-actions">
              <button type="submit" className="btn btn-primary btn-lg" disabled={!canSave}>
                {saving ? 'Saving…' : creating ? 'Create draft' : 'Save draft'}
              </button>
              <AppLink
                href={rulebookId === undefined ? CATALOG_PATH : rulebookPath(rulebookId)}
                onNavigate={onNavigate}
                className="btn btn-outline btn-lg"
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
              refreshToken={versionsRefreshToken}
              onChanged={handleLifecycleChange}
              onSessionExpired={() => {
                setSessionExpired(true)
                setRenewedNotice(null)
              }}
            />
          )}
        </div>
      </main>
      <SiteFooter onNavigate={onNavigate} />
    </div>
  )
}
