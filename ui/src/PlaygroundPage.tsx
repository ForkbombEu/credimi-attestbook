import { useCallback, useEffect, useRef, useState } from 'react'

import { CatalogApiError, isAbortError, type CatalogApi, type ValidationApi } from './api'
import { EmptyState, ErrorState, LoadingState } from './components/CatalogStates'
import { SiteFooter, SiteHeader, SkipLink } from './components/Layout'
import { PlaygroundForm } from './components/PlaygroundForm'
import { ValidationReport } from './components/ValidationReport'
import { versionsNewestFirst } from './detail'
import {
  EMPTY_PLAYGROUND_FORM,
  MAX_CREDENTIAL_LENGTH,
  type PlaygroundFormErrors,
  type PlaygroundFormValues,
  buildValidationRequest,
  hasFormErrors,
  validatePlaygroundForm,
  validationResultDocument,
  validationResultFilename,
} from './playground'
import { AppLink, CATALOG_PATH } from './router'
import type { Attestation, CredentialValidationResult, Rulebook, RulebookVersion } from './types'

interface PlaygroundPageProps {
  readonly api: CatalogApi
  readonly validator: ValidationApi
  readonly onNavigate: (path: string) => void
}

type CatalogState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready'
      readonly rulebooks: readonly Rulebook[]
      readonly total: number
    }
  | { readonly status: 'error'; readonly message: string }

type RelatedLoadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready'
      readonly versions: readonly RulebookVersion[]
      readonly attestations: readonly Attestation[]
    }
  | { readonly status: 'error'; readonly message: string }

type RunState =
  | { readonly status: 'idle' }
  | { readonly status: 'running' }
  | { readonly status: 'success'; readonly result: CredentialValidationResult }
  | { readonly status: 'error'; readonly message: string }

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof CatalogApiError || error instanceof Error) {
    return error.message === '' ? fallback : error.message
  }
  return fallback
}

function triggerJsonDownload(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'application/json' })
  const link = document.createElement('a')
  link.download = filename
  if (typeof URL.createObjectURL === 'function') {
    const url = URL.createObjectURL(blob)
    link.href = url
    link.click()
    // Revoke after the browser has started the download.
    setTimeout(() => URL.revokeObjectURL(url), 0)
    return
  }
  link.href = `data:application/json;charset=utf-8,${encodeURIComponent(text)}`
  link.click()
}

export function PlaygroundPage({ api, validator, onNavigate }: PlaygroundPageProps) {
  const [catalog, setCatalog] = useState<CatalogState>({ status: 'loading' })
  const [catalogReloadToken, setCatalogReloadToken] = useState(0)
  const [related, setRelated] = useState<RelatedLoadState>({ status: 'idle' })
  const [relatedReloadToken, setRelatedReloadToken] = useState(0)
  const [values, setValues] = useState<PlaygroundFormValues>(EMPTY_PLAYGROUND_FORM)
  const [errors, setErrors] = useState<PlaygroundFormErrors>({})
  const [fileError, setFileError] = useState<string | null>(null)
  const [run, setRun] = useState<RunState>({ status: 'idle' })
  const [exported, setExported] = useState(false)
  const runController = useRef<AbortController | null>(null)
  // Bumped whenever the form changes; a file read only applies when its token
  // is still current, so a late read cannot overwrite a newer form state.
  const fileReadToken = useRef(0)

  useEffect(() => {
    document.title = 'Credential playground · AttestBook'
  }, [])

  // Load the public rulebook catalogue. A failure is the page-level error
  // state; the validation request cannot be built without a registered
  // rulebook.
  useEffect(() => {
    const controller = new AbortController()
    setCatalog({ status: 'loading' })
    api
      .listRulebooks(controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) {
          setCatalog({ status: 'ready', rulebooks: page.data, total: page.pagination.total })
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setCatalog({
            status: 'error',
            message: errorMessage(error, 'The rulebook catalog request failed.'),
          })
        }
      })
    return () => controller.abort()
  }, [api, catalogReloadToken])

  // Versions and attestation types are loaded only for the selected rulebook.
  // A failure degrades this form section instead of hiding the page.
  useEffect(() => {
    if (values.rulebookId === '') {
      setRelated({ status: 'idle' })
      return
    }
    const controller = new AbortController()
    setRelated({ status: 'loading' })
    Promise.all([
      api.listVersions(values.rulebookId, controller.signal),
      api.listAttestations(values.rulebookId, controller.signal),
    ])
      .then(([versions, attestations]) => {
        if (!controller.signal.aborted) {
          setRelated({ status: 'ready', versions, attestations })
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !isAbortError(error)) {
          setRelated({
            status: 'error',
            message: errorMessage(error, 'The related rulebook request failed.'),
          })
        }
      })
    return () => controller.abort()
  }, [api, values.rulebookId, relatedReloadToken])

  // A rulebook change resets the two dependent selections. Keep them only
  // while they still exist in the freshly loaded version/attestation lists.
  useEffect(() => {
    if (related.status !== 'ready') {
      return
    }
    setValues((current) => {
      const versionExists = related.versions.some(
        (version) => version.version === current.rulebookVersion,
      )
      const attestationExists = related.attestations.some(
        (attestation) => attestation.name === current.attestationType,
      )
      if (versionExists && attestationExists) {
        return current
      }
      return {
        ...current,
        rulebookVersion: versionExists ? current.rulebookVersion : '',
        attestationType: attestationExists ? current.attestationType : '',
      }
    })
  }, [related])

  useEffect(() => {
    return () => runController.current?.abort()
  }, [])

  const handleChange = useCallback((patch: Partial<PlaygroundFormValues>) => {
    // Editing the request invalidates an in-flight run, a pending file read or
    // a displayed result.
    fileReadToken.current += 1
    runController.current?.abort()
    runController.current = null
    setValues((current) => {
      if ('rulebookId' in patch && patch.rulebookId !== current.rulebookId) {
        return {
          ...current,
          ...patch,
          rulebookVersion: '',
          attestationType: '',
          credential: current.credential,
        }
      }
      return { ...current, ...patch }
    })
    setErrors({})
    setRun({ status: 'idle' })
    setExported(false)
  }, [])

  const handleRetryRelated = useCallback(() => {
    setRelatedReloadToken((token) => token + 1)
  }, [])

  const handleClear = useCallback(() => {
    fileReadToken.current += 1
    runController.current?.abort()
    runController.current = null
    setValues(EMPTY_PLAYGROUND_FORM)
    setErrors({})
    setFileError(null)
    setRun({ status: 'idle' })
    setExported(false)
  }, [])

  const handleSubmit = useCallback(() => {
    const nextErrors = validatePlaygroundForm(values)
    setErrors(nextErrors)
    if (hasFormErrors(nextErrors)) {
      setRun({ status: 'idle' })
      return
    }

    runController.current?.abort()
    const controller = new AbortController()
    runController.current = controller
    setRun({ status: 'running' })
    setExported(false)

    validator
      .validateCredential(buildValidationRequest(values), controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setRun({ status: 'success', result })
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) {
          return
        }
        setRun({
          status: 'error',
          message:
            error instanceof CatalogApiError
              ? error.message
              : 'The validation request failed. Try again.',
        })
      })
  }, [validator, values])

  const handleFile = useCallback((file: File) => {
    // Reading a new file invalidates an in-flight or displayed result.
    const readToken = fileReadToken.current + 1
    fileReadToken.current = readToken
    runController.current?.abort()
    runController.current = null
    setFileError(null)
    if (file.size > MAX_CREDENTIAL_LENGTH) {
      setFileError('The selected file is larger than 512 KiB.')
      return
    }
    file
      .text()
      .then((text) => {
        if (fileReadToken.current !== readToken) {
          return
        }
        // A run started while the read was pending belongs to the previous
        // text; abort it before replacing the credential.
        runController.current?.abort()
        runController.current = null
        setValues((current) => ({ ...current, credential: text }))
        setErrors({})
        setRun({ status: 'idle' })
        setExported(false)
      })
      .catch(() => {
        if (fileReadToken.current === readToken) {
          setFileError('The selected file could not be read. Choose a text file and try again.')
        }
      })
  }, [])

  const handleExport = useCallback(() => {
    if (run.status !== 'success') {
      return
    }
    triggerJsonDownload(validationResultDocument(run.result), validationResultFilename(run.result))
    setExported(true)
  }, [run])

  const relatedMessage = related.status === 'error' ? related.message : null
  const versions = related.status === 'ready' ? versionsNewestFirst(related.versions) : []
  const attestations = related.status === 'ready' ? related.attestations : []

  return (
    <div className="app-shell">
      <SkipLink href="#playground">Skip to the validation playground</SkipLink>

      <SiteHeader section="Credential playground" onNavigate={onNavigate} />

      <main className="page" id="main-content">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <ol>
            <li>
              <AppLink href={CATALOG_PATH} onNavigate={onNavigate}>
                Rulebook catalog
              </AppLink>
            </li>
            <li aria-current="page">Credential playground</li>
          </ol>
        </nav>

        <div className="page-heading">
          <p className="eyebrow">Validator</p>
          <h1>Credential playground</h1>
          <p className="lede">
            Run the real structural validation API against a pinned rulebook version. Inspect the
            per-dimension evidence and violations, then export the typed result. This page never
            reports an untested dimension as a pass.
          </p>
        </div>

        <div id="playground" tabIndex={-1}>
          {catalog.status === 'loading' ? (
            <LoadingState
              title="Loading rulebooks…"
              detail="Reading the public rulebook API."
              rowCount={3}
            />
          ) : null}

          {catalog.status === 'error' ? (
            <ErrorState
              title="The rulebooks could not be loaded."
              message={catalog.message}
              onRetry={() => setCatalogReloadToken((token) => token + 1)}
            />
          ) : null}

          {catalog.status === 'ready' && catalog.rulebooks.length === 0 ? (
            <EmptyState filtering={false} onClear={() => undefined} />
          ) : null}

          {catalog.status === 'ready' && catalog.rulebooks.length > 0 ? (
            <>
              {catalog.total > catalog.rulebooks.length ? (
                <p className="notice">
                  Showing the first {catalog.rulebooks.length} of {catalog.total} rulebooks; the
                  rulebook selector covers only these {catalog.rulebooks.length}.
                </p>
              ) : null}
              <PlaygroundForm
                rulebooks={catalog.rulebooks}
                versions={versions}
                attestations={attestations}
                values={values}
                errors={errors}
                relatedState={related.status}
                relatedMessage={relatedMessage}
                fileError={fileError}
                running={run.status === 'running'}
                onChange={handleChange}
                onSubmit={handleSubmit}
                onClear={handleClear}
                onRetryRelated={handleRetryRelated}
                onFile={handleFile}
              />

              {run.status === 'error' ? (
                <ErrorState
                  title="The validation request failed."
                  message={run.message}
                  onRetry={handleSubmit}
                />
              ) : null}

              {run.status === 'success' ? (
                <>
                  <p className="sr-only" role="status" aria-live="polite">
                    Validation finished with overall status {run.result.overallStatus}.
                    {exported ? ' The result was exported as JSON.' : ''}
                  </p>
                  <ValidationReport result={run.result} onExport={handleExport} />
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </main>

      <SiteFooter />
    </div>
  )
}
