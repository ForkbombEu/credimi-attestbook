// The rulebook editor's attestation form (contract §2).
//
// The editor no longer exposes a raw Draft JSON textarea. Attestations are
// added, edited and removed through this section, and each supported format
// carries its own schema reference controls. Every change is still applied to
// the serialized draft document the page owns, so unknown members survive.

import { useId, useState } from 'react'

import type { EditorApi } from '../api'
import {
  ATTESTATION_LOS_VALUES,
  BINDING_TYPE_VALUES,
  CREDENTIAL_FORMAT_VALUES,
  credentialFormatLabel,
  validateAttestation,
  type AttestationDraft,
} from '../draft'
import {
  addAttestation,
  removeAttestation,
  replaceAttestation,
  schemaControlAttestations,
  type SchemaControlAttestation,
} from '../schema-reference'
import type { DraftContentDocument, DraftSchemaReference, HostedSchema } from '../types'
import { Alert } from './Alert'
import { GuideLink } from './GuideLink'
import { SchemaReferenceControls } from './SchemaReferenceControls'

interface AttestationTypesSectionProps {
  readonly api: EditorApi
  readonly document: DraftContentDocument
  readonly documentText: string
  readonly disabled: boolean
  readonly csrfToken: string | null
  readonly hostedSchemas: ReadonlyMap<string, HostedSchema>
  readonly onDocumentChange: (text: string) => void
  readonly onSessionExpired: () => void
}

const DEFAULT_ATTESTATION: AttestationDraft = {
  name: '',
  attestationLoS: ATTESTATION_LOS_VALUES[0],
  bindingType: 'key',
  supportedFormats: [],
}

function draftOf(attestation: SchemaControlAttestation): AttestationDraft {
  return {
    name: attestation.name,
    attestationLoS: attestation.attestationLoS ?? ATTESTATION_LOS_VALUES[0],
    bindingType: attestation.bindingType ?? 'key',
    supportedFormats: attestation.formats,
  }
}

interface AttestationFormProps {
  readonly initial: AttestationDraft | null
  readonly disabled: boolean
  readonly onSave: (draft: AttestationDraft) => void
  readonly onCancel: () => void
}

function AttestationForm({ initial, disabled, onSave, onCancel }: AttestationFormProps) {
  const fieldId = useId()
  const prefix = `attestation-form-${fieldId.replaceAll(':', '')}`
  const [draft, setDraft] = useState<AttestationDraft>(initial ?? DEFAULT_ATTESTATION)
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})

  const update = (patch: Partial<AttestationDraft>) => {
    setDraft((current) => ({ ...current, ...patch }))
  }

  const toggleFormat = (format: string, checked: boolean) => {
    const selected = new Set(draft.supportedFormats)
    if (checked) {
      selected.add(format)
    } else {
      selected.delete(format)
    }
    // Keep any format outside the two contract values so editing never drops
    // data the form does not model.
    const other = draft.supportedFormats.filter(
      (candidate) =>
        !CREDENTIAL_FORMAT_VALUES.includes(candidate as (typeof CREDENTIAL_FORMAT_VALUES)[number]),
    )
    update({
      supportedFormats: [
        ...other,
        ...CREDENTIAL_FORMAT_VALUES.filter((candidate) => selected.has(candidate)),
      ],
    })
  }

  const handleSubmit = () => {
    const nextErrors = validateAttestation(draft)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      return
    }
    onSave({ ...draft, name: draft.name.trim() })
  }

  return (
    <div
      className="attestation-form"
      onKeyDown={(event) => {
        // The attestation form is not a <form> because it renders inside the
        // page's draft form, and a nested form would make Enter or a submit
        // button save the whole draft. Enter submits only this form instead.
        if (
          event.key === 'Enter' &&
          event.target instanceof HTMLInputElement &&
          event.target.type !== 'checkbox'
        ) {
          event.preventDefault()
          handleSubmit()
        }
      }}
    >
      <div className="editor-grid">
        <div className="field">
          <label htmlFor={`${prefix}-name`}>Attestation name</label>
          <input
            id={`${prefix}-name`}
            value={draft.name}
            onChange={(event) => {
              update({ name: event.target.value })
              setErrors((current) => {
                const next = { ...current }
                delete next.name
                return next
              })
            }}
            required
            disabled={disabled}
            aria-invalid={errors.name !== undefined}
            aria-describedby={errors.name === undefined ? undefined : `${prefix}-name-error`}
          />
          {errors.name === undefined ? null : (
            <p className="field-error" id={`${prefix}-name-error`}>
              {errors.name}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-los`}>Level of assurance</label>
          <select
            id={`${prefix}-los`}
            value={draft.attestationLoS}
            onChange={(event) => update({ attestationLoS: event.target.value })}
            disabled={disabled}
          >
            {ATTESTATION_LOS_VALUES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-binding`}>Binding type</label>
          <select
            id={`${prefix}-binding`}
            value={draft.bindingType}
            onChange={(event) => update({ bindingType: event.target.value })}
            disabled={disabled}
          >
            {BINDING_TYPE_VALUES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <fieldset
          className="field attestation-form__formats"
          aria-describedby={errors.formats === undefined ? undefined : `${prefix}-formats-error`}
        >
          <legend>Supported formats</legend>
          <div className="attestation-form__format-options">
            {CREDENTIAL_FORMAT_VALUES.map((format) => (
              <label className="attestation-form__format" key={format}>
                <input
                  type="checkbox"
                  checked={draft.supportedFormats.includes(format)}
                  onChange={(event) => {
                    toggleFormat(format, event.target.checked)
                    setErrors((current) => {
                      const next = { ...current }
                      delete next.formats
                      return next
                    })
                  }}
                  disabled={disabled}
                />
                <span>{credentialFormatLabel(format)}</span>
              </label>
            ))}
          </div>
          {errors.formats === undefined ? null : (
            <p className="field-error" id={`${prefix}-formats-error`}>
              {errors.formats}
            </p>
          )}
        </fieldset>
      </div>
      <div className="editor-actions attestation-form__actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={handleSubmit}
          disabled={disabled}
        >
          Save attestation
        </button>
        <button type="button" className="btn btn-outline btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function RulebookLevelReferences({
  references,
}: {
  readonly references: readonly DraftSchemaReference[]
}) {
  return (
    <div className="attestation-rulebook-references">
      <h3>Rulebook-level schema references</h3>
      <p className="field-hint">
        These references belong to no attestation type. The form keeps them unchanged in the saved
        draft and they cannot be edited here.
      </p>
      <ul className="attestation-rulebook-references__list">
        {references.map((reference, index) => (
          <li key={`${reference.formatIdentifier}-${reference.uri}-${index}`}>
            <code>{reference.formatIdentifier}</code> <span className="data">{reference.uri}</span>
            {reference.integrity === null ? (
              <span className="muted"> · No integrity pin</span>
            ) : (
              <span className="data"> · {reference.integrity}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function AttestationTypesSection({
  api,
  document,
  documentText,
  disabled,
  csrfToken,
  hostedSchemas,
  onDocumentChange,
  onSessionExpired,
}: AttestationTypesSectionProps) {
  const fieldId = useId()
  const prefix = `attestation-types-${fieldId.replaceAll(':', '')}`
  const attestations = schemaControlAttestations(document)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const handleSave = (index: number | null, draft: AttestationDraft) => {
    const edit =
      index === null
        ? addAttestation(documentText, draft)
        : replaceAttestation(documentText, index, draft)
    if (!edit.ok) {
      setFormError(edit.message)
      return
    }
    onDocumentChange(edit.text)
    setFormError(null)
    setAdding(false)
    setEditing(null)
    setNotice(
      `${index === null ? 'Added' : 'Updated'} the attestation ${draft.name}. Save the draft to keep the change.`,
    )
  }

  const handleRemove = (attestation: SchemaControlAttestation) => {
    const edit = removeAttestation(documentText, attestation.index)
    if (!edit.ok) {
      setFormError(edit.message)
      return
    }
    onDocumentChange(edit.text)
    setFormError(null)
    setEditing(null)
    setAdding(false)
    setNotice(`Removed the attestation ${attestation.name}. Save the draft to keep the change.`)
  }

  return (
    <section className="content-section" aria-labelledby={`${prefix}-heading`}>
      <h2 id={`${prefix}-heading`}>Attestation types</h2>
      <p className="field-hint schema-reference-intro">
        Each attestation type declares its name, level of assurance, binding type and supported
        formats, with one schema reference per format. A hosted schema also carries the credential
        type (vct or docType); it is optional while drafting and required before publication. Read
        the <GuideLink slug="credential-schemas">credential schemas guide</GuideLink> for hosted and
        external references.
      </p>

      {disabled ? (
        <p className="field-hint">
          Read-only: attestation types and schema references can be changed only while the rulebook
          is a draft.
        </p>
      ) : null}

      {notice === null ? null : (
        <Alert variant="info" role="status">
          <p>{notice}</p>
        </Alert>
      )}
      {formError === null ? null : (
        <Alert
          variant="destructive"
          role="alert"
          title="The attestation was not changed"
          titleAs="h3"
        >
          <p>{formError}</p>
        </Alert>
      )}

      {document.schemaReferences.length === 0 ? null : (
        <RulebookLevelReferences references={document.schemaReferences} />
      )}

      <div className="attestation-list">
        {attestations.length === 0 ? (
          <p className="field-hint">
            No attestation types yet. Add one to describe the credentials this rulebook covers.
          </p>
        ) : null}
        {attestations.map((attestation) => (
          <article
            className="attestation-card"
            key={attestation.index}
            aria-labelledby={`${prefix}-attestation-${attestation.index}`}
          >
            <div className="attestation-card__header">
              <div className="attestation-card__summary">
                <h3
                  className="attestation-card__title"
                  id={`${prefix}-attestation-${attestation.index}`}
                >
                  {attestation.name}
                </h3>
                <p className="attestation-card__meta">
                  <span>
                    Level of assurance: <code>{attestation.attestationLoS ?? 'not declared'}</code>
                  </span>
                  <span>
                    Binding type: <code>{attestation.bindingType ?? 'not declared'}</code>
                  </span>
                  <span>
                    Formats:{' '}
                    {attestation.formats.length === 0
                      ? 'none'
                      : attestation.formats
                          .map((format) => credentialFormatLabel(format))
                          .join(', ')}
                  </span>
                </p>
              </div>
              <div className="schema-row__actions">
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => {
                    setEditing(attestation.index)
                    setAdding(false)
                    setNotice(null)
                    setFormError(null)
                  }}
                  disabled={disabled}
                  aria-label={`Edit attestation ${attestation.name}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => handleRemove(attestation)}
                  disabled={disabled}
                  aria-label={`Remove attestation ${attestation.name}`}
                >
                  Remove
                </button>
              </div>
            </div>

            {editing === attestation.index ? (
              <AttestationForm
                key={`edit-${attestation.index}`}
                initial={draftOf(attestation)}
                disabled={disabled}
                onSave={(draft) => handleSave(attestation.index, draft)}
                onCancel={() => setEditing(null)}
              />
            ) : null}

            <SchemaReferenceControls
              api={api}
              attestationIndex={attestation.index}
              document={document}
              documentText={documentText}
              disabled={disabled}
              csrfToken={csrfToken}
              hostedSchemas={hostedSchemas}
              onDocumentChange={onDocumentChange}
              onSessionExpired={onSessionExpired}
            />
          </article>
        ))}
      </div>

      {adding ? (
        <AttestationForm
          key="new-attestation"
          initial={null}
          disabled={disabled}
          onSave={(draft) => handleSave(null, draft)}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          className="btn btn-outline btn-md attestation-add"
          onClick={() => {
            setAdding(true)
            setEditing(null)
            setNotice(null)
            setFormError(null)
          }}
          disabled={disabled}
        >
          + Add new attestation
        </button>
      )}
    </section>
  )
}
