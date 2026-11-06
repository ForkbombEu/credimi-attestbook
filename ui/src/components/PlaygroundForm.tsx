import type { ChangeEvent } from 'react'

import {
  CREDENTIAL_FORMAT_OPTIONS,
  type PlaygroundFormErrors,
  type PlaygroundFormField,
  type PlaygroundFormValues,
  hasFormErrors,
} from '../playground'
import type { Attestation, CredentialFormatHint, Rulebook, RulebookVersion } from '../types'
import { PUBLICATION_STATUS_LABELS } from '../catalog'

export type RelatedState = 'idle' | 'loading' | 'ready' | 'error'

interface PlaygroundFormProps {
  readonly rulebooks: readonly Rulebook[]
  readonly versions: readonly RulebookVersion[]
  readonly attestations: readonly Attestation[]
  readonly values: PlaygroundFormValues
  readonly errors: PlaygroundFormErrors
  readonly relatedState: RelatedState
  readonly relatedMessage: string | null
  readonly fileError: string | null
  readonly running: boolean
  readonly onChange: (patch: Partial<PlaygroundFormValues>) => void
  readonly onSubmit: () => void
  readonly onClear: () => void
  readonly onRetryRelated: () => void
  readonly onFile: (file: File) => void
}

const CREDENTIAL_HINT = 'Paste a credential artifact or upload one from a file.'

function errorProps(field: PlaygroundFormField, errors: PlaygroundFormErrors) {
  const message = errors[field]
  return {
    'aria-invalid': message === undefined ? undefined : true,
    'aria-describedby': message === undefined ? undefined : `playground-${field}-error`,
  }
}

export function PlaygroundForm({
  rulebooks,
  versions,
  attestations,
  values,
  errors,
  relatedState,
  relatedMessage,
  fileError,
  running,
  onChange,
  onSubmit,
  onClear,
  onRetryRelated,
  onFile,
}: PlaygroundFormProps) {
  const selectedRulebook = rulebooks.find((rulebook) => rulebook.id === values.rulebookId) ?? null
  const selectedAttestation =
    attestations.find((attestation) => attestation.name === values.attestationType) ?? null
  const formHasErrors = hasFormErrors(errors)
  const relatedLoading = relatedState === 'loading'
  const rulebookSelected = values.rulebookId !== ''

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    // Reset the control so selecting the same file again still fires `change`.
    event.currentTarget.value = ''
    if (file !== undefined) {
      onFile(file)
    }
  }

  const errorEntries = Object.entries(errors) as [PlaygroundFormField, string][]

  return (
    <section className="detail-card" aria-labelledby="playground-request-heading">
      <h2 id="playground-request-heading">Validation request</h2>
      <p className="table-note playground-disclosure">
        The credential is sent only to <code>POST /api/v1/credentials/validate</code> for this run.
        It is never stored, logged or included in the exported result.
      </p>

      {formHasErrors ? (
        <div className="state-panel state-panel--error playground-error-summary" role="alert">
          <h3 className="state-title">Check the request before running validation</h3>
          <ul>
            {errorEntries.map(([field, message]) => (
              <li key={field}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="playground-grid">
        <div className="field">
          <label htmlFor="playground-rulebook">Rulebook</label>
          <select
            id="playground-rulebook"
            value={values.rulebookId}
            onChange={(event) => onChange({ rulebookId: event.target.value })}
            {...errorProps('rulebook', errors)}
          >
            <option value="">Select a rulebook…</option>
            {rulebooks.map((rulebook) => (
              <option value={rulebook.id} key={rulebook.id}>
                {rulebook.name}
              </option>
            ))}
          </select>
          {errors.rulebook === undefined ? null : (
            <p className="field-error" id="playground-rulebook-error">
              {errors.rulebook}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="playground-version">Rulebook version</label>
          <select
            id="playground-version"
            value={values.rulebookVersion}
            onChange={(event) => onChange({ rulebookVersion: event.target.value })}
            disabled={!rulebookSelected || relatedLoading}
            {...errorProps('version', errors)}
          >
            <option value="">{relatedLoading ? 'Loading versions…' : 'Select a version…'}</option>
            {versions.map((version) => (
              <option value={version.version} key={version.id}>
                {version.version} · {PUBLICATION_STATUS_LABELS[version.status]}
              </option>
            ))}
          </select>
          {errors.version === undefined ? null : (
            <p className="field-error" id="playground-version-error">
              {errors.version}
            </p>
          )}
          {!rulebookSelected ? (
            <p className="field-hint">Select a rulebook to load its versions.</p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="playground-attestation">Attestation type</label>
          <select
            id="playground-attestation"
            value={values.attestationType}
            onChange={(event) => onChange({ attestationType: event.target.value })}
            disabled={!rulebookSelected || relatedLoading}
            {...errorProps('attestation', errors)}
          >
            <option value="">
              {relatedLoading ? 'Loading attestation types…' : 'Select an attestation type…'}
            </option>
            {attestations.map((attestation) => (
              <option value={attestation.name} key={attestation.id}>
                {attestation.name}
              </option>
            ))}
          </select>
          {errors.attestation === undefined ? null : (
            <p className="field-error" id="playground-attestation-error">
              {errors.attestation}
            </p>
          )}
          {selectedAttestation === null ? null : (
            <p className="field-hint">
              {selectedAttestation.attestationLoS} · {selectedAttestation.bindingType} ·{' '}
              {selectedAttestation.supportedFormats.length === 0
                ? 'no supported formats recorded'
                : selectedAttestation.supportedFormats.join(', ')}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="playground-format">Credential format hint (optional)</label>
          <select
            id="playground-format"
            value={values.format}
            onChange={(event) =>
              onChange({ format: event.target.value as '' | CredentialFormatHint })
            }
          >
            {CREDENTIAL_FORMAT_OPTIONS.map((option) => (
              <option value={option.value} key={option.label}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="field-hint">
            Auto-detection recognises a real compact SD-JWT VC. Other formats are reported without
            being parsed.
          </p>
        </div>
      </div>

      {relatedState === 'error' ? (
        <div className="notice notice--warning" role="alert">
          <p className="notice-title">
            The rulebook versions or attestation types could not be loaded.
          </p>
          <p>{relatedMessage ?? 'The related rulebook read failed.'}</p>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={onRetryRelated}
          >
            Retry rulebook details
          </button>
        </div>
      ) : null}

      {selectedRulebook === null ? null : (
        <p className="playground-selection">
          Validating against <strong>{selectedRulebook.name}</strong>
          {values.rulebookVersion === '' ? null : (
            <>
              {' '}
              version <code>{values.rulebookVersion}</code>
            </>
          )}
          .
        </p>
      )}

      <div className="field field--credential">
        <label htmlFor="playground-credential">Credential</label>
        <textarea
          id="playground-credential"
          className="credential-input"
          value={values.credential}
          onChange={(event) => onChange({ credential: event.target.value })}
          rows={10}
          spellCheck={false}
          placeholder={CREDENTIAL_HINT}
          {...errorProps('credential', errors)}
        />
        {errors.credential === undefined ? null : (
          <p className="field-error" id="playground-credential-error">
            {errors.credential}
          </p>
        )}
        <p className="field-hint">
          A compact SD-JWT VC pasted here or read from a file. Leading and trailing whitespace is
          removed; the artifact is sent unchanged otherwise.
        </p>
      </div>

      <div className="field field--upload">
        <label htmlFor="playground-upload">Upload a credential file</label>
        <input
          id="playground-upload"
          type="file"
          accept=".sd-jwt,.jwt,.txt,.json,application/json,text/plain"
          onChange={handleFile}
          aria-describedby={
            fileError === null ? 'playground-upload-hint' : 'playground-upload-error'
          }
        />
        {fileError === null ? (
          <p className="field-hint" id="playground-upload-hint">
            The selected file replaces the pasted text. It is read in this browser and sent only
            when you run validation.
          </p>
        ) : (
          <p className="field-error" id="playground-upload-error" role="alert">
            {fileError}
          </p>
        )}
      </div>

      <div className="playground-actions">
        <button
          type="button"
          className="button button--primary"
          onClick={onSubmit}
          disabled={running}
        >
          {running ? 'Validating…' : 'Run validation'}
        </button>
        <button type="button" className="button button--ghost" onClick={onClear} disabled={running}>
          Clear form
        </button>
        <span className="playground-run-status" role="status" aria-live="polite">
          {running ? 'Validating the credential against the pinned rulebook version…' : ''}
        </span>
      </div>
    </section>
  )
}
