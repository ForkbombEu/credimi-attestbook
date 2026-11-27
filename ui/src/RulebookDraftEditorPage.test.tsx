import { useState } from 'react'

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { UserEvent } from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { CatalogApiError, type EditorApi } from './api'
import { RulebookDraftEditorPage } from './RulebookDraftEditorPage'
import { expectNoA11yViolations } from './test/a11y'
import { HOSTED_SCHEMA } from './test/fixtures'
import { anonymousSession, fakeSession, TEST_SESSION } from './test/session'
import type { SessionController } from './session'
import type {
  CredentialSchemaDocument,
  DraftRulebook,
  DraftValidationReport,
  PublicationReadiness,
  Rulebook,
  RulebookVersion,
  SaveDraftRequest,
} from './types'

const DRAFT: DraftRulebook = {
  id: 'rulebook-1',
  providerId: 'provider-1',
  name: 'PID Rulebook',
  description: 'Person identification data.',
  sourceUrl: 'https://issuer.example.org/rulebooks/pid',
  applicableSpec: 'ts11@1.0.1',
  publicationStatus: 'draft',
  attestations: [
    {
      name: 'Person Identification Data',
      attestationLoS: 'iso_18045_high',
      bindingType: 'key',
      supportedFormats: ['dc+sd-jwt'],
      schemaReferences: [
        {
          formatIdentifier: 'dc+sd-jwt',
          uri: 'https://issuer.example.org/schemas/pid',
          integrity: 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
        },
      ],
    },
  ],
  schemaReferences: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const SCHEMA_TEXT = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'PID schema',
  type: 'object',
  properties: { family_name: { type: 'string' } },
})

const REGISTERED: CredentialSchemaDocument = {
  id: 'document-1',
  kind: 'json_schema_2020_12',
  mediaType: 'application/schema+json',
  contentDigest: 'b'.repeat(64),
  integrity: 'sha256-c2NoZW1hLWludGVncml0eQ==',
  url: 'https://schemas.example/api/v1/schema-documents/document-1/content',
  createdAt: '2026-01-02T00:00:00.000Z',
}

const CREATED: Rulebook = {
  id: 'rulebook-2',
  providerId: 'provider-1',
  name: 'New draft',
  description: '',
  sourceUrl: null,
  applicableSpec: 'ts11@1.0.1',
  publicationStatus: 'draft',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return {
    promise,
    resolve: (value: T) => {
      resolve?.(value)
    },
  }
}

function report(overrides: Partial<DraftValidationReport> = {}): DraftValidationReport {
  return {
    valid: true,
    saveable: true,
    profile: 'ts11@1.0.1',
    diagnostics: [],
    limitations: ['Structural checks are not a conformance claim.'],
    ...overrides,
  }
}

function version(overrides: Partial<RulebookVersion> = {}): RulebookVersion {
  return {
    id: 'version-1-0',
    rulebookId: DRAFT.id,
    version: '1.0',
    status: 'draft',
    contentDigest: 'a'.repeat(64),
    specVersion: 'ts11@1.0.1',
    createdAt: '2026-01-02T00:00:00.000Z',
    publishedAt: null,
    ...overrides,
  }
}

function readiness(overrides: Partial<PublicationReadiness> = {}): PublicationReadiness {
  return {
    version: version(),
    ready: true,
    checks: [
      {
        id: 'draft_version',
        status: 'pass',
        message: 'The version is a draft and can be published.',
      },
      {
        id: 'credential_types',
        status: 'pass',
        message: 'Every declared format resolves to a hosted schema with a credential type.',
      },
    ],
    limitations: ['Readiness is not a standards-conformance claim.'],
    ...overrides,
  }
}

function editor(overrides: Partial<EditorApi> = {}): EditorApi {
  return {
    getDraft: vi.fn(async () => DRAFT),
    replaceDraft: vi.fn(async () => DRAFT),
    createDraft: vi.fn(async () => CREATED),
    validateDraft: vi.fn(async () => report()),
    registerSchemaDocument: vi.fn(async () => REGISTERED),
    listVersions: vi.fn(async () => [version()]),
    getPublicationReadiness: vi.fn(async () => readiness()),
    createVersion: vi.fn(async (_rulebookId, label) => version({ version: label })),
    refreshVersion: vi.fn(async () => version()),
    publishVersion: vi.fn(async () =>
      version({ status: 'published', publishedAt: '2026-01-03T00:00:00.000Z' }),
    ),
    ...overrides,
  }
}

/** Fills and submits the inline attestation form, leaving the document changed. */
async function addAttestationThroughForm(
  user: UserEvent,
  fields: {
    readonly name: string
    readonly los?: string
    readonly binding?: string
    readonly formats: readonly ('dc+sd-jwt' | 'mso_mdoc')[]
  },
): Promise<void> {
  await user.click(screen.getByRole('button', { name: '+ Add new attestation' }))
  const container = screen
    .getByRole('button', { name: 'Save attestation' })
    .closest('.attestation-form')
  if (!(container instanceof HTMLElement)) {
    throw new Error('the attestation form must render')
  }
  const form = container
  await user.type(within(form).getByLabelText('Attestation name'), fields.name)
  if (fields.los !== undefined) {
    await user.selectOptions(within(form).getByLabelText('Level of assurance'), fields.los)
  }
  if (fields.binding !== undefined) {
    await user.selectOptions(within(form).getByLabelText('Binding type'), fields.binding)
  }
  for (const format of fields.formats) {
    await user.click(
      within(form).getByRole('checkbox', {
        name: format === 'dc+sd-jwt' ? 'SD-JWT VC (dc+sd-jwt)' : 'mdoc (mso_mdoc)',
      }),
    )
  }
  await user.click(within(form).getByRole('button', { name: 'Save attestation' }))
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Save attestation' })).not.toBeInTheDocument(),
  )
}

function attestationCard(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name, level: 3 })
  const card = heading.closest('article')
  if (!(card instanceof HTMLElement)) {
    throw new Error(`the attestation card for ${name} must render`)
  }
  return card
}

function schemaRow(attestationName: string, formatIdentifier: string): HTMLElement {
  const format = within(attestationCard(attestationName)).getByText(formatIdentifier, {
    selector: '.schema-row__format code',
  })
  const row = format.closest('.schema-row')
  if (!(row instanceof HTMLElement)) {
    throw new Error(`the schema row for ${formatIdentifier} must render`)
  }
  return row
}

function attestationForm(): HTMLElement {
  const form = screen.getByRole('button', { name: 'Save attestation' }).closest('.attestation-form')
  if (!(form instanceof HTMLElement)) {
    throw new Error('the attestation form must render')
  }
  return form
}

function renderEditor(
  api: EditorApi,
  options: {
    readonly rulebookId?: string
    readonly session?: SessionController
    readonly onNavigate?: (path: string) => void
  } = {},
) {
  return render(
    <RulebookDraftEditorPage
      api={api}
      {...(options.rulebookId === undefined ? {} : { rulebookId: options.rulebookId })}
      session={options.session ?? fakeSession()}
      onNavigate={options.onNavigate ?? (() => {})}
    />,
  )
}

/** A mutable session controller for the sign-out then inline-sign-in path. */
function SessionHarness({ api }: { readonly api: EditorApi }) {
  const authenticate = () => {
    setSession(fakeSession({ signIn: () => Promise.resolve(TEST_SESSION) }))
    return Promise.resolve(TEST_SESSION)
  }
  const [session, setSession] = useState<SessionController>(() =>
    fakeSession({ signIn: authenticate }),
  )
  return (
    <>
      <button type="button" onClick={() => setSession(anonymousSession({ signIn: authenticate }))}>
        Become anonymous
      </button>
      <RulebookDraftEditorPage
        api={api}
        rulebookId={DRAFT.id}
        session={session}
        onNavigate={() => {}}
      />
    </>
  )
}

describe('rulebook draft editor', () => {
  test('loads the draft working copy and validates it live', async () => {
    const api = editor()
    renderEditor(api, { rulebookId: DRAFT.id })

    expect(await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })).toBeVisible()
    expect(screen.getByLabelText('Name')).toHaveValue('PID Rulebook')
    expect(screen.getByLabelText('Applicable specification')).toHaveValue('ts11@1.0.1')
    expect(screen.getByLabelText('Source URL (optional)')).toHaveValue(
      'https://issuer.example.org/rulebooks/pid',
    )
    expect(screen.getByRole('heading', { name: 'Attestation types' })).toBeVisible()
    const card = attestationCard('Person Identification Data')
    expect(within(card).getByText('iso_18045_high')).toBeVisible()
    expect(within(card).getByText(/SD-JWT VC \(dc\+sd-jwt\)/)).toBeVisible()
    expect(within(card).getByText('https://issuer.example.org/schemas/pid')).toBeVisible()

    await waitFor(() => expect(api.validateDraft).toHaveBeenCalled())
    expect(await screen.findByText('No validation findings.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled()
  })

  test('shows structural findings and blocks saving when the draft is not saveable', async () => {
    const api = editor({
      validateDraft: vi.fn(async () =>
        report({
          valid: false,
          saveable: false,
          diagnostics: [
            {
              severity: 'error',
              code: 'invalid_member_value',
              message: '"name" must not be empty',
              path: 'attestations.0.name',
            },
          ],
        }),
      ),
    })
    renderEditor(api, { rulebookId: DRAFT.id })

    expect(await screen.findByText('1 error found.')).toBeVisible()
    expect(screen.getByRole('cell', { name: 'attestations › 0 › name' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled()
  })

  test('keeps saving available for standards warnings', async () => {
    const api = editor({
      validateDraft: vi.fn(async () =>
        report({
          diagnostics: [
            {
              severity: 'warning',
              code: 'incomplete_attestation',
              message: 'no schema references yet',
              path: 'attestations.0.schemaReferences',
            },
          ],
        }),
      ),
    })
    renderEditor(api, { rulebookId: DRAFT.id })

    expect(await screen.findByText('1 warning found.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled()
  })

  test('requires a name and at least one format before saving an attestation', async () => {
    const api = editor()
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Attestation types' })
    await user.click(screen.getByRole('button', { name: '+ Add new attestation' }))
    await user.click(screen.getByRole('button', { name: 'Save attestation' }))

    expect(await screen.findByText('An attestation name is required.')).toBeVisible()
    expect(screen.getByText('Choose at least one supported format.')).toBeVisible()
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Save attestation' })).toBeVisible()
  })

  test('saves with the session CSRF token and no bearer token', async () => {
    const api = editor()
    const user = userEvent.setup()
    const saved = { ...DRAFT, description: 'Updated' }
    api.replaceDraft = vi.fn(async () => saved)
    const view = renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    await waitFor(() => expect(api.validateDraft).toHaveBeenCalled())
    await screen.findByText('No validation findings.')
    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    await waitFor(() => expect(api.replaceDraft).toHaveBeenCalled())
    expect(api.replaceDraft).toHaveBeenCalledWith(
      DRAFT.id,
      expect.objectContaining({ name: 'PID Rulebook', applicableSpec: 'ts11@1.0.1' }),
      'csrf-token-value',
    )
    expect(await screen.findByText(/Draft saved at/)).toBeVisible()
    // No bearer-token field exists in the authenticated editor.
    expect(view.queryByLabelText(/bearer token/i)).not.toBeInTheDocument()
  })

  test('sends an anonymous visitor to sign in with a safe return path', async () => {
    window.history.replaceState({}, '', '/rulebooks/rulebook-1/edit')
    const api = editor()
    renderEditor(api, { rulebookId: DRAFT.id, session: anonymousSession() })

    expect(
      await screen.findByRole('heading', { name: 'Sign in to author rulebooks' }),
    ).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Attestation types' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?next=%2Frulebooks%2Frulebook-1%2Fedit',
    )
    expect(api.getDraft).not.toHaveBeenCalled()
  })

  test('keeps unsaved edits on an expired session and signs in again inline', async () => {
    const api = editor({
      replaceDraft: vi.fn(async () => {
        throw new CatalogApiError('Authentication is required.', 401)
      }),
    })
    const user = userEvent.setup()
    const signIn = vi.fn(async () => ({
      provider: { id: 'provider-1', name: 'Example Issuer', createdAt: '2026-01-01T00:00:00.000Z' },
      expiresAt: '2026-01-01T08:00:00.000Z',
      csrfToken: 'new-csrf-token',
    }))
    renderEditor(api, { rulebookId: DRAFT.id, session: fakeSession({ signIn }) })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    await waitFor(() => expect(api.validateDraft).toHaveBeenCalled())
    await screen.findByText('No validation findings.')
    await user.clear(screen.getByLabelText('Description'))
    await user.type(screen.getByLabelText('Description'), 'Do not lose this text')
    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    expect(await screen.findByRole('heading', { name: 'Sign in again' })).toBeVisible()
    expect(screen.getByLabelText('Description')).toHaveValue('Do not lose this text')

    await user.type(screen.getByLabelText('Username'), 'admin')
    await user.type(screen.getByLabelText('Password'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Sign in again' }))

    await waitFor(() => expect(signIn).toHaveBeenCalledWith('admin', 'secret'))
    expect(screen.getByLabelText('Description')).toHaveValue('Do not lose this text')
    expect(screen.queryByRole('heading', { name: 'Sign in again' })).not.toBeInTheDocument()
  })

  test('creates a new draft and navigates to its editor', async () => {
    const api = editor()
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    renderEditor(api, { onNavigate })

    await screen.findByRole('heading', { name: 'New rulebook draft' })
    await user.type(screen.getByLabelText('Name'), 'New draft')
    await waitFor(() => expect(api.validateDraft).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: 'Create draft' }))

    await waitFor(() => expect(api.createDraft).toHaveBeenCalled())
    expect(onNavigate).toHaveBeenCalledWith('/rulebooks/rulebook-2/edit')
  })

  test('shows a published rulebook as read-only', async () => {
    const api = editor({
      getDraft: vi.fn(async () => ({ ...DRAFT, publicationStatus: 'published' as const })),
    })
    renderEditor(api, { rulebookId: DRAFT.id })

    expect(await screen.findByText('This rulebook is published.')).toBeVisible()
    expect(screen.getByLabelText('Name')).toBeDisabled()
    expect(screen.getByRole('button', { name: '+ Add new attestation' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Edit attestation Person Identification Data' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Remove attestation Person Identification Data' }),
    ).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled()
  })

  test('keeps unsaved edits across sign-out and inline sign-in without re-fetching', async () => {
    const api = editor()
    const user = userEvent.setup()
    render(<SessionHarness api={api} />)

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    await waitFor(() => expect(api.validateDraft).toHaveBeenCalled())
    await screen.findByText('No validation findings.')
    await user.clear(screen.getByLabelText('Description'))
    await user.type(screen.getByLabelText('Description'), 'Do not lose this text')

    await user.click(screen.getByRole('button', { name: 'Become anonymous' }))

    expect(await screen.findByRole('heading', { name: 'Sign in again' })).toBeVisible()
    expect(screen.getByLabelText('Description')).toHaveValue('Do not lose this text')
    expect(api.getDraft).toHaveBeenCalledTimes(1)

    await user.type(screen.getByLabelText('Username'), 'admin')
    await user.type(screen.getByLabelText('Password'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Sign in again' }))

    await waitFor(() => expect(api.getDraft).toHaveBeenCalledTimes(1))
    expect(screen.getByLabelText('Description')).toHaveValue('Do not lose this text')

    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(api.replaceDraft).toHaveBeenCalled())
    expect(api.replaceDraft).toHaveBeenCalledWith(
      DRAFT.id,
      expect.objectContaining({ description: 'Do not lose this text' }),
      'csrf-token-value',
    )
  })

  test('reports an ownership 403 without offering a pointless re-sign-in', async () => {
    const api = editor({
      replaceDraft: vi.fn(async () => {
        throw new CatalogApiError(
          'The authenticated provider does not own this resource.',
          403,
          'forbidden',
        )
      }),
    })
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    await waitFor(() => expect(api.validateDraft).toHaveBeenCalled())
    await screen.findByText('No validation findings.')
    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    expect(
      await screen.findByText('The authenticated provider does not own this resource.'),
    ).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Sign in again' })).not.toBeInTheDocument()
  })

  test('offers re-sign-in for a 403 csrf_failed rejection', async () => {
    const api = editor({
      replaceDraft: vi.fn(async () => {
        throw new CatalogApiError(
          'The request is missing or carries an invalid CSRF token; sign in again.',
          403,
          'csrf_failed',
        )
      }),
    })
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    await waitFor(() => expect(api.validateDraft).toHaveBeenCalled())
    await screen.findByText('No validation findings.')
    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    expect(await screen.findByRole('heading', { name: 'Sign in again' })).toBeVisible()
  })

  test('never renders a provider bearer-token field', async () => {
    renderEditor(editor(), { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    expect(screen.queryByLabelText(/bearer token/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/provider token/i)).not.toBeInTheDocument()
  })

  test('gates publish on readiness and reports the published status', async () => {
    const api = editor()
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    const lifecycle = await screen.findByRole('region', {
      name: 'Draft lifecycle and publication',
    })
    const publish = within(lifecycle).getByRole('button', { name: 'Publish' })
    expect(publish).toBeDisabled()

    await user.click(within(lifecycle).getByRole('button', { name: 'Check readiness' }))
    expect(
      await within(lifecycle).findByText('Ready to publish: every blocking check passed.'),
    ).toBeVisible()
    expect(
      within(lifecycle).getByText(
        'Every declared format resolves to a hosted schema with a credential type.',
      ),
    ).toBeVisible()
    expect(publish).toBeEnabled()

    await user.click(publish)
    await waitFor(() =>
      expect(api.publishVersion).toHaveBeenCalledWith(DRAFT.id, '1.0', 'csrf-token-value'),
    )
    expect(await within(lifecycle).findByText(/is now published and immutable/)).toBeVisible()
    expect(screen.getByText('This rulebook is published.')).toBeVisible()
    // A published rulebook offers the next-version flow instead of freezing
    // another version in place.
    expect(screen.getByRole('region', { name: 'Create a new version' })).toBeVisible()
    expect(
      within(lifecycle).queryByRole('button', { name: 'Freeze as draft version' }),
    ).not.toBeInTheDocument()
  })

  test('keeps publish disabled when the readiness rulebook-status check fails', async () => {
    const api = editor({
      getPublicationReadiness: vi.fn(async () =>
        readiness({
          ready: false,
          checks: [
            {
              id: 'rulebook_status',
              status: 'fail',
              message:
                'The rulebook is already published; create the next draft version before publishing another draft.',
            },
          ],
        }),
      ),
    })
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    const lifecycle = await screen.findByRole('region', {
      name: 'Draft lifecycle and publication',
    })
    await user.click(within(lifecycle).getByRole('button', { name: 'Check readiness' }))

    expect(
      await within(lifecycle).findByText(/Not ready to publish: resolve the failed checks first/),
    ).toBeVisible()
    expect(
      within(lifecycle).getByText(
        'The rulebook is already published; create the next draft version before publishing another draft.',
      ),
    ).toBeVisible()
    expect(within(lifecycle).getByRole('button', { name: 'Publish' })).toBeDisabled()
  })

  test('freezes the working copy under a typed version label', async () => {
    const api = editor({ listVersions: vi.fn(async () => []) })
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    const lifecycle = await screen.findByRole('region', {
      name: 'Draft lifecycle and publication',
    })
    expect(await within(lifecycle).findByText(/No versions have been frozen/)).toBeVisible()

    await user.type(within(lifecycle).getByLabelText('New version label'), '2.0')
    await user.click(within(lifecycle).getByRole('button', { name: 'Freeze as draft version' }))

    await waitFor(() =>
      expect(api.createVersion).toHaveBeenCalledWith(DRAFT.id, '2.0', 'csrf-token-value'),
    )
    expect(await within(lifecycle).findByText(/Draft version 2.0 frozen/)).toBeVisible()
  })

  test('surfaces a stale-snapshot conflict from the publish action', async () => {
    const api = editor({
      publishVersion: vi.fn(async () => {
        throw new CatalogApiError(
          'The draft version content is stale; refresh it before publishing.',
          409,
        )
      }),
    })
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    const lifecycle = await screen.findByRole('region', {
      name: 'Draft lifecycle and publication',
    })
    await user.click(within(lifecycle).getByRole('button', { name: 'Check readiness' }))
    await within(lifecycle).findByText('Ready to publish: every blocking check passed.')
    await user.click(within(lifecycle).getByRole('button', { name: 'Publish' }))

    const alert = await within(lifecycle).findByRole('alert')
    expect(alert).toHaveTextContent('The lifecycle action was rejected')
    expect(alert).toHaveTextContent('refresh it before publishing')
  })

  test('surfaces an expired session from a lifecycle write', async () => {
    const api = editor({
      createVersion: vi.fn(async () => {
        throw new CatalogApiError('Authentication is required.', 401)
      }),
    })
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    const lifecycle = await screen.findByRole('region', {
      name: 'Draft lifecycle and publication',
    })
    await user.type(within(lifecycle).getByLabelText('New version label'), '2.0')
    await user.click(within(lifecycle).getByRole('button', { name: 'Freeze as draft version' }))

    expect(await screen.findByRole('heading', { name: 'Sign in again' })).toBeVisible()
    expect(within(lifecycle).getByLabelText('New version label')).toHaveValue('2.0')
  })

  test('reports an ownership 403 from a lifecycle write without re-sign-in', async () => {
    const api = editor({
      createVersion: vi.fn(async () => {
        throw new CatalogApiError(
          'The authenticated provider does not own this resource.',
          403,
          'forbidden',
        )
      }),
    })
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    const lifecycle = await screen.findByRole('region', {
      name: 'Draft lifecycle and publication',
    })
    await user.type(within(lifecycle).getByLabelText('New version label'), '2.0')
    await user.click(within(lifecycle).getByRole('button', { name: 'Freeze as draft version' }))

    expect(
      await within(lifecycle).findByText('The authenticated provider does not own this resource.'),
    ).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Sign in again' })).not.toBeInTheDocument()
  })

  test('uses the API association, not a URL prefix, to mark a draft reference hosted', async () => {
    const lookalike = 'https://attestbook.example/api/v1/schema-documents/not-registered/content'
    const loaded: DraftRulebook = {
      ...DRAFT,
      attestations: [
        {
          ...DRAFT.attestations[0]!,
          supportedFormats: ['dc+sd-jwt', 'mso_mdoc'],
          schemaReferences: [
            {
              formatIdentifier: 'dc+sd-jwt',
              uri: HOSTED_SCHEMA.url,
              integrity: HOSTED_SCHEMA.integrity,
              hostedSchema: HOSTED_SCHEMA,
            },
            {
              formatIdentifier: 'mso_mdoc',
              uri: lookalike,
              integrity: null,
              hostedSchema: null,
            },
          ],
        },
      ],
    }
    renderEditor(editor({ getDraft: vi.fn(async () => loaded) }), { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    const hostedRow = screen.getByText(HOSTED_SCHEMA.url).closest('.schema-row') as HTMLElement
    expect(within(hostedRow).getByText('Hosted by AttestBook')).toBeVisible()
    expect(within(hostedRow).getByText('JSON Schema 2020-12')).toBeVisible()
    expect(within(hostedRow).getByText('application/schema+json')).toBeVisible()
    expect(within(hostedRow).getByText(`${'c'.repeat(16)}…`)).toBeVisible()
    expect(
      within(hostedRow).getByRole('link', { name: /Download the hosted JSON Schema 2020-12/ }),
    ).toHaveAttribute('href', HOSTED_SCHEMA.url)

    const externalRow = screen.getByText(lookalike).closest('.schema-row') as HTMLElement
    expect(within(externalRow).getByText('External URL')).toBeVisible()
    expect(
      within(externalRow).queryByRole('link', { name: /Download the hosted/ }),
    ).not.toBeInTheDocument()
  })

  test('registers a pasted hosted schema and inserts its URI and integrity into the attestation', async () => {
    const api = editor()
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    await waitFor(() => expect(api.validateDraft).toHaveBeenCalled())
    await user.click(
      screen.getByRole('button', {
        name: 'Replace schema for Person Identification Data (dc+sd-jwt)',
      }),
    )
    await user.click(screen.getByRole('radio', { name: /Upload\/paste schema to AttestBook/ }))
    fireEvent.change(screen.getByLabelText('JSON Schema document'), {
      target: { value: SCHEMA_TEXT },
    })

    expect(screen.getByText(/Valid JSON Schema/)).toBeVisible()
    await user.click(
      screen.getByRole('button', {
        name: 'Register and insert schema for Person Identification Data (dc+sd-jwt)',
      }),
    )

    await waitFor(() =>
      expect(api.registerSchemaDocument).toHaveBeenCalledWith(
        'json_schema_2020_12',
        SCHEMA_TEXT,
        'csrf-token-value',
      ),
    )
    expect(
      await screen.findByText('Hosted schema registered and added to the draft.'),
    ).toBeVisible()
    const row = schemaRow('Person Identification Data', 'dc+sd-jwt')
    expect(within(row).getByText(REGISTERED.url)).toBeVisible()
    expect(within(row).getByText(REGISTERED.integrity)).toBeVisible()
  })

  test('applies a registration to the latest draft document, not the click-time copy', async () => {
    const pending = deferred<CredentialSchemaDocument>()
    const replaceDraft = vi.fn(async (_rulebookId: string, _request: SaveDraftRequest) => DRAFT)
    const api = editor({ registerSchemaDocument: vi.fn(() => pending.promise), replaceDraft })
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    await waitFor(() => expect(api.validateDraft).toHaveBeenCalled())
    await user.click(
      screen.getByRole('button', {
        name: 'Replace schema for Person Identification Data (dc+sd-jwt)',
      }),
    )
    await user.click(screen.getByRole('radio', { name: /Upload\/paste schema to AttestBook/ }))
    fireEvent.change(screen.getByLabelText('JSON Schema document'), {
      target: { value: SCHEMA_TEXT },
    })
    await user.click(
      screen.getByRole('button', {
        name: 'Register and insert schema for Person Identification Data (dc+sd-jwt)',
      }),
    )

    // The attestation form stays editable while the registration is in flight.
    await addAttestationThroughForm(user, { name: 'Loyalty Card', formats: ['mso_mdoc'] })
    expect(screen.getByRole('heading', { name: 'Loyalty Card', level: 3 })).toBeVisible()

    await act(async () => {
      pending.resolve(REGISTERED)
      await pending.promise
    })
    expect(screen.getByRole('heading', { name: 'Loyalty Card', level: 3 })).toBeVisible()

    expect(
      await screen.findByText('Hosted schema registered and added to the draft.'),
    ).toBeVisible()
    expect(screen.getAllByRole('article')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(replaceDraft).toHaveBeenCalled())
    expect(replaceDraft).toHaveBeenCalledTimes(1)

    const request = replaceDraft.mock.calls[0]?.[1] as {
      readonly attestations: readonly {
        readonly name: string
        readonly supportedFormats: readonly string[]
        readonly schemaReferences: readonly unknown[]
      }[]
    }
    expect(request.attestations.map((attestation) => attestation.name)).toEqual([
      'Person Identification Data',
      'Loyalty Card',
    ])
    expect(request.attestations[1]).toMatchObject({
      name: 'Loyalty Card',
      supportedFormats: ['mso_mdoc'],
    })
    expect(request.attestations[0]?.schemaReferences).toContainEqual({
      formatIdentifier: 'dc+sd-jwt',
      uri: REGISTERED.url,
      integrity: REGISTERED.integrity,
    })
  })

  test('keeps the registered URL when the attestation changed during registration', async () => {
    const pending = deferred<CredentialSchemaDocument>()
    const api = editor({ registerSchemaDocument: vi.fn(() => pending.promise) })
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    await waitFor(() => expect(api.validateDraft).toHaveBeenCalled())
    await user.click(
      screen.getByRole('button', {
        name: 'Replace schema for Person Identification Data (dc+sd-jwt)',
      }),
    )
    await user.click(screen.getByRole('radio', { name: /Upload\/paste schema to AttestBook/ }))
    fireEvent.change(screen.getByLabelText('JSON Schema document'), {
      target: { value: SCHEMA_TEXT },
    })
    await user.click(
      screen.getByRole('button', {
        name: 'Register and insert schema for Person Identification Data (dc+sd-jwt)',
      }),
    )

    // Rename the attestation while its schema registration is in flight.
    const card = attestationCard('Person Identification Data')
    await user.click(
      within(card).getByRole('button', { name: 'Edit attestation Person Identification Data' }),
    )
    const form = screen
      .getByRole('button', { name: 'Save attestation' })
      .closest('.attestation-form')
    if (!(form instanceof HTMLElement)) {
      throw new Error('the attestation form must render')
    }
    const name = within(form).getByLabelText('Attestation name')
    await user.clear(name)
    await user.type(name, 'Renamed Attestation')
    await user.click(within(form).getByRole('button', { name: 'Save attestation' }))

    await act(async () => {
      pending.resolve(REGISTERED)
      await pending.promise
    })

    expect(
      await screen.findByText(
        'The attestation changed while the schema was being registered; insert the reference again.',
      ),
    ).toBeVisible()
    expect(await screen.findByText('Hosted schema registered but not inserted.')).toBeVisible()
    expect(screen.getByText(REGISTERED.url)).toBeVisible()

    const row = schemaRow('Renamed Attestation', 'dc+sd-jwt')
    expect(within(row).getByText('https://issuer.example.org/schemas/pid')).toBeVisible()
    expect(within(row).queryByText(REGISTERED.url)).not.toBeInTheDocument()
  })

  test('accepts a .json file for a hosted schema and reports parse feedback', async () => {
    const api = editor()
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    await waitFor(() => expect(api.validateDraft).toHaveBeenCalled())
    await user.click(
      screen.getByRole('button', {
        name: 'Replace schema for Person Identification Data (dc+sd-jwt)',
      }),
    )
    await user.click(screen.getByRole('radio', { name: /Upload\/paste schema to AttestBook/ }))

    const file = new File([SCHEMA_TEXT], 'pid-schema.json', { type: 'application/json' })
    await user.upload(screen.getByLabelText('Or choose a .json file'), file)
    expect(await screen.findByText(/Loaded pid-schema\.json/)).toBeVisible()
    expect(await screen.findByText(/Valid JSON Schema/)).toBeVisible()

    fireEvent.change(screen.getByLabelText('JSON Schema document'), {
      target: { value: '{not-json' },
    })
    expect(await screen.findByText('This is not valid JSON.')).toBeVisible()
    expect(
      screen.getByRole('button', {
        name: 'Register and insert schema for Person Identification Data (dc+sd-jwt)',
      }),
    ).toBeDisabled()
  })

  test('inserts an external schema URL with an optional SRI pin without uploading', async () => {
    const api = editor()
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    await waitFor(() => expect(api.validateDraft).toHaveBeenCalled())
    await user.click(
      screen.getByRole('button', {
        name: 'Replace schema for Person Identification Data (dc+sd-jwt)',
      }),
    )
    expect(screen.getByText(/AttestBook cannot inspect an external schema/)).toBeVisible()
    expect(screen.getByRole('radio', { name: /Use existing external URL/ })).toBeChecked()
    fireEvent.change(screen.getByLabelText('Schema URL'), {
      target: { value: 'https://issuer.example.org/schemas/pid-v2' },
    })
    fireEvent.change(screen.getByLabelText('SRI integrity (optional)'), {
      target: { value: 'sha256-NEWPINSHA256NEWPINSHA256NEWPINSHA256NEWPIN=' },
    })
    await user.click(
      screen.getByRole('button', {
        name: 'Insert external reference for Person Identification Data (dc+sd-jwt)',
      }),
    )

    expect(await screen.findByText('External schema reference added to the draft.')).toBeVisible()
    expect(api.registerSchemaDocument).not.toHaveBeenCalled()
    const row = schemaRow('Person Identification Data', 'dc+sd-jwt')
    expect(within(row).getByText('https://issuer.example.org/schemas/pid-v2')).toBeVisible()
    expect(
      within(row).getByText('sha256-NEWPINSHA256NEWPINSHA256NEWPINSHA256NEWPIN='),
    ).toBeVisible()
  })

  test('keeps multiple attestations and formats unambiguous when inserting a schema', async () => {
    const twoAttestations: DraftRulebook = {
      ...DRAFT,
      attestations: [
        { ...DRAFT.attestations[0]!, name: 'Payment Account', schemaReferences: [] },
        { ...DRAFT.attestations[0]!, name: 'Account Details', schemaReferences: [] },
      ],
    }
    const replaceDraft = vi.fn(async (_rulebookId: string, _request: SaveDraftRequest) => DRAFT)
    const api = editor({ getDraft: vi.fn(async () => twoAttestations), replaceDraft })
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    expect(
      screen.getByRole('button', { name: 'Add schema for Payment Account (dc+sd-jwt)' }),
    ).toBeVisible()
    await user.click(
      screen.getByRole('button', { name: 'Add schema for Account Details (dc+sd-jwt)' }),
    )
    expect(
      screen.getByText('Account Details', { selector: '.schema-form__title strong' }),
    ).toBeVisible()

    await user.click(screen.getByRole('radio', { name: /Use existing external URL/ }))
    fireEvent.change(screen.getByLabelText('Schema URL'), {
      target: { value: 'https://issuer.example.org/schemas/account-details' },
    })
    await user.click(
      screen.getByRole('button', {
        name: 'Insert external reference for Account Details (dc+sd-jwt)',
      }),
    )

    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(replaceDraft).toHaveBeenCalled())
    const request = replaceDraft.mock.calls[0]?.[1] as {
      readonly attestations: readonly {
        readonly name: string
        readonly schemaReferences: readonly { readonly uri: string }[]
      }[]
    }
    expect(request.attestations[0]?.schemaReferences).toEqual([])
    expect(request.attestations[1]?.schemaReferences).toEqual([
      {
        formatIdentifier: 'dc+sd-jwt',
        uri: 'https://issuer.example.org/schemas/account-details',
      },
    ])
  })

  test('does not render a raw draft document editor', async () => {
    renderEditor(editor(), { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Attestation types' })
    expect(screen.queryByLabelText('Draft JSON')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Attestations and schema references' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /draft json/i })).not.toBeInTheDocument()
  })

  test('adds, edits and removes an attestation through the form', async () => {
    const replaceDraft = vi.fn(async (_rulebookId: string, _request: SaveDraftRequest) => DRAFT)
    const api = editor({ replaceDraft })
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Attestation types' })
    await addAttestationThroughForm(user, {
      name: 'Loyalty Card',
      los: 'iso_18045_basic',
      binding: 'claim',
      formats: ['mso_mdoc'],
    })

    const added = attestationCard('Loyalty Card')
    expect(within(added).getByText('iso_18045_basic')).toBeVisible()
    expect(within(added).getByText('claim')).toBeVisible()
    expect(within(added).getByText(/mdoc \(mso_mdoc\)/)).toBeVisible()

    await user.click(within(added).getByRole('button', { name: 'Edit attestation Loyalty Card' }))
    const form = attestationForm()
    const name = within(form).getByLabelText('Attestation name')
    await user.clear(name)
    await user.type(name, 'Loyalty Card v2')
    await user.click(within(form).getByRole('checkbox', { name: 'SD-JWT VC (dc+sd-jwt)' }))
    await user.click(within(form).getByRole('button', { name: 'Save attestation' }))

    expect(screen.getByRole('heading', { name: 'Loyalty Card v2', level: 3 })).toBeVisible()
    expect(
      within(attestationCard('Loyalty Card v2')).getByText(
        /SD-JWT VC \(dc\+sd-jwt\), mdoc \(mso_mdoc\)/,
      ),
    ).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Remove attestation Loyalty Card v2' }))
    expect(screen.queryByRole('heading', { name: 'Loyalty Card v2' })).not.toBeInTheDocument()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(replaceDraft).toHaveBeenCalled())
    const request = replaceDraft.mock.calls[0]?.[1] as {
      readonly attestations: readonly { readonly name: string }[]
    }
    expect(request.attestations.map((attestation) => attestation.name)).toEqual([
      'Person Identification Data',
    ])
  })

  test('keeps a binding type outside the TS11 vocabulary visible and unchanged when editing', async () => {
    const legacy: DraftRulebook = {
      ...DRAFT,
      attestations: [{ ...DRAFT.attestations[0]!, bindingType: 'cryptographic' }],
    }
    const replaceDraft = vi.fn(async (_rulebookId: string, _request: SaveDraftRequest) => legacy)
    const api = editor({ getDraft: vi.fn(async () => legacy), replaceDraft })
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Attestation types' })
    await user.click(
      screen.getByRole('button', { name: 'Edit attestation Person Identification Data' }),
    )
    const binding = within(attestationForm()).getByLabelText('Binding type')
    // The select shows the stored value instead of silently displaying `claim`.
    expect(binding).toHaveValue('cryptographic')
    expect(within(binding).getByRole('option', { selected: true })).toHaveTextContent(
      'cryptographic (outside TS11 v1.0.1)',
    )

    await user.click(within(attestationForm()).getByRole('button', { name: 'Save attestation' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(replaceDraft).toHaveBeenCalled())
    const request = replaceDraft.mock.calls[0]?.[1] as {
      readonly attestations: readonly { readonly bindingType: string }[]
    }
    expect(request.attestations[0]?.bindingType).toBe('cryptographic')
  })

  test('drops a format schema reference when the format is unchecked', async () => {
    const twoFormats: DraftRulebook = {
      ...DRAFT,
      attestations: [
        {
          ...DRAFT.attestations[0]!,
          supportedFormats: ['dc+sd-jwt', 'mso_mdoc'],
          schemaReferences: [
            DRAFT.attestations[0]!.schemaReferences[0]!,
            {
              formatIdentifier: 'mso_mdoc',
              uri: 'https://issuer.example.org/schemas/pid-mdoc',
              integrity: null,
            },
          ],
        },
      ],
    }
    const replaceDraft = vi.fn(async (_rulebookId: string, _request: SaveDraftRequest) => DRAFT)
    const api = editor({ getDraft: vi.fn(async () => twoFormats), replaceDraft })
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    expect(
      screen.getByRole('button', {
        name: 'Replace schema for Person Identification Data (mso_mdoc)',
      }),
    ).toBeVisible()
    await user.click(
      screen.getByRole('button', { name: 'Edit attestation Person Identification Data' }),
    )
    const form = attestationForm()
    await user.click(within(form).getByRole('checkbox', { name: 'mdoc (mso_mdoc)' }))
    await user.click(within(form).getByRole('button', { name: 'Save attestation' }))

    expect(
      screen.queryByRole('button', {
        name: 'Add schema for Person Identification Data (mso_mdoc)',
      }),
    ).not.toBeInTheDocument()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(replaceDraft).toHaveBeenCalled())
    const request = replaceDraft.mock.calls[0]?.[1] as {
      readonly attestations: readonly {
        readonly schemaReferences: readonly { readonly formatIdentifier: string }[]
      }[]
    }
    expect(request.attestations[0]?.schemaReferences).toEqual([
      {
        formatIdentifier: 'dc+sd-jwt',
        uri: 'https://issuer.example.org/schemas/pid',
        integrity: 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
      },
    ])
  })

  test('prefills and merges the credential type into the registered schema', async () => {
    const api = editor()
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    await waitFor(() => expect(api.validateDraft).toHaveBeenCalled())
    await user.click(
      screen.getByRole('button', {
        name: 'Replace schema for Person Identification Data (dc+sd-jwt)',
      }),
    )
    await user.click(screen.getByRole('radio', { name: /Upload\/paste schema to AttestBook/ }))

    const declared = JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { vct: { const: 'urn:declared:vct' } },
    })
    fireEvent.change(screen.getByLabelText('JSON Schema document'), {
      target: { value: declared },
    })
    const credentialType = screen.getByLabelText('Credential type (vct)')
    expect(credentialType).toHaveValue('urn:declared:vct')

    fireEvent.change(screen.getByLabelText('JSON Schema document'), {
      target: { value: SCHEMA_TEXT },
    })
    expect(credentialType).toHaveValue('')
    await user.type(credentialType, 'urn:eudi:pid:1')
    await user.click(
      screen.getByRole('button', {
        name: 'Register and insert schema for Person Identification Data (dc+sd-jwt)',
      }),
    )

    await waitFor(() => expect(api.registerSchemaDocument).toHaveBeenCalled())
    const call = vi.mocked(api.registerSchemaDocument).mock.calls[0]
    expect(call?.[0]).toBe('json_schema_2020_12')
    expect(call?.[2]).toBe('csrf-token-value')
    const registered = JSON.parse(call?.[1] ?? '{}') as {
      readonly required: readonly string[]
      readonly properties: Record<string, { readonly const?: string }>
    }
    expect(registered.properties.vct?.const).toBe('urn:eudi:pid:1')
    expect(registered.required).toContain('vct')
    // The rest of the pasted schema is preserved.
    expect(registered.properties.family_name).toEqual({ type: 'string' })
  })

  test('blocks an mso_mdoc schema without a namespace and shows CBOR guidance', async () => {
    const mdocDraft: DraftRulebook = {
      ...DRAFT,
      attestations: [
        {
          ...DRAFT.attestations[0]!,
          supportedFormats: ['mso_mdoc'],
          schemaReferences: [],
        },
      ],
    }
    const api = editor({ getDraft: vi.fn(async () => mdocDraft) })
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    await user.click(
      screen.getByRole('button', {
        name: 'Add schema for Person Identification Data (mso_mdoc)',
      }),
    )
    await user.click(screen.getByRole('radio', { name: /Upload\/paste schema to AttestBook/ }))
    fireEvent.change(screen.getByLabelText('JSON Schema document'), {
      target: {
        value: JSON.stringify({
          type: 'object',
          properties: {
            docType: { type: 'string' },
            birth_date: { type: 'string', format: 'int32' },
          },
        }),
      },
    })

    expect(screen.getByText(/CBOR full-date/)).toBeVisible()
    expect(screen.getByText(/declares no namespace/)).toBeVisible()
    expect(screen.getByText('properties.birth_date.format')).toBeVisible()
    expect(screen.getByLabelText('Document type (docType)')).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Register and insert schema for Person Identification Data (mso_mdoc)',
      }),
    ).toBeDisabled()

    fireEvent.change(screen.getByLabelText('JSON Schema document'), {
      target: {
        value: JSON.stringify({
          type: 'object',
          properties: {
            docType: { type: 'string' },
            'eu.europa.ec.eudi.pid.1': {
              type: 'object',
              properties: { family_name: { type: 'string' } },
            },
          },
        }),
      },
    })
    expect(screen.getByText(/Namespaces:/)).toBeVisible()
    expect(
      screen.getByRole('button', {
        name: 'Register and insert schema for Person Identification Data (mso_mdoc)',
      }),
    ).toBeEnabled()
  })

  test('keeps rulebook-level schema references read-only and saves them unchanged', async () => {
    const rulebookReference = {
      formatIdentifier: 'mso_mdoc',
      uri: 'https://issuer.example.org/schemas/rulebook-level',
      integrity: null,
    }
    const withRulebookReference: DraftRulebook = {
      ...DRAFT,
      schemaReferences: [rulebookReference],
    }
    const replaceDraft = vi.fn(async (_rulebookId: string, _request: SaveDraftRequest) => DRAFT)
    const api = editor({ getDraft: vi.fn(async () => withRulebookReference), replaceDraft })
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Rulebook-level schema references' })
    expect(screen.getByText(rulebookReference.uri)).toBeVisible()
    expect(screen.queryByRole('button', { name: /Edit .*rulebook-level/i })).not.toBeInTheDocument()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(replaceDraft).toHaveBeenCalled())
    expect(replaceDraft.mock.calls[0]?.[1]).toMatchObject({
      schemaReferences: [
        {
          formatIdentifier: 'mso_mdoc',
          uri: 'https://issuer.example.org/schemas/rulebook-level',
        },
      ],
    })
  })

  test('keeps the pasted schema when the administrator session expires during registration', async () => {
    const api = editor({
      registerSchemaDocument: vi.fn(async () => {
        throw new CatalogApiError('Authentication is required.', 401)
      }),
    })
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    await waitFor(() => expect(api.validateDraft).toHaveBeenCalled())
    await user.click(
      screen.getByRole('button', {
        name: 'Replace schema for Person Identification Data (dc+sd-jwt)',
      }),
    )
    await user.click(screen.getByRole('radio', { name: /Upload\/paste schema to AttestBook/ }))
    fireEvent.change(screen.getByLabelText('JSON Schema document'), {
      target: { value: SCHEMA_TEXT },
    })
    await user.click(
      screen.getByRole('button', {
        name: 'Register and insert schema for Person Identification Data (dc+sd-jwt)',
      }),
    )

    expect(await screen.findByRole('heading', { name: 'Sign in again' })).toBeVisible()
    expect((screen.getByLabelText('JSON Schema document') as HTMLTextAreaElement).value).toBe(
      SCHEMA_TEXT,
    )
    expect(screen.queryByText(REGISTERED.url)).not.toBeInTheDocument()
  })

  test('removes an existing schema reference from the attestation', async () => {
    const api = editor()
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    await user.click(
      screen.getByRole('button', {
        name: 'Remove schema for Person Identification Data (dc+sd-jwt)',
      }),
    )

    expect(
      await screen.findByText(
        'Removed the schema reference for Person Identification Data (dc+sd-jwt). Save the draft to keep the change.',
      ),
    ).toBeVisible()
    const row = schemaRow('Person Identification Data', 'dc+sd-jwt')
    expect(within(row).getByText('No schema attached')).toBeVisible()
  })

  test('shows the schema controls as read-only for a published rulebook', async () => {
    const api = editor({
      getDraft: vi.fn(async () => ({ ...DRAFT, publicationStatus: 'published' as const })),
    })
    renderEditor(api, { rulebookId: DRAFT.id })

    expect(await screen.findByText('This rulebook is published.')).toBeVisible()
    expect(
      screen.getByRole('button', {
        name: 'Replace schema for Person Identification Data (dc+sd-jwt)',
      }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', {
        name: 'Remove schema for Person Identification Data (dc+sd-jwt)',
      }),
    ).toBeDisabled()
  })

  describe('creating the next version from a published rulebook', () => {
    const PUBLISHED_DRAFT: DraftRulebook = { ...DRAFT, publicationStatus: 'published' }
    const PUBLISHED_VERSION = version({
      id: 'version-published',
      status: 'published',
      publishedAt: '2026-01-02T00:00:00.000Z',
    })

    function publishedApi(overrides: Partial<EditorApi> = {}): EditorApi {
      let versions: RulebookVersion[] = [PUBLISHED_VERSION]
      return editor({
        getDraft: vi.fn(async () => PUBLISHED_DRAFT),
        listVersions: vi.fn(async () => versions),
        createVersion: vi.fn(async (_rulebookId, label) => {
          const created = version({ id: `version-${label}`, version: label, status: 'draft' })
          versions = [created, ...versions]
          return created
        }),
        ...overrides,
      })
    }

    test('opens a published rulebook in the next-version flow and reopens the working copy in place', async () => {
      const api = publishedApi()
      const user = userEvent.setup()
      renderEditor(api, { rulebookId: DRAFT.id })

      expect(
        await screen.findByRole('heading', { name: 'Create a new version of PID Rulebook' }),
      ).toBeVisible()
      expect(screen.getByText('This rulebook is published.')).toBeVisible()
      expect(screen.getByLabelText('Name')).toBeDisabled()

      const panel = screen.getByRole('region', { name: 'Create a new version' })
      await user.type(within(panel).getByLabelText('New version label'), '1.1.0')
      await user.click(within(panel).getByRole('button', { name: 'Create new version' }))

      await waitFor(() =>
        expect(api.createVersion).toHaveBeenCalledWith(DRAFT.id, '1.1.0', 'csrf-token-value'),
      )
      expect(await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })).toBeVisible()
      expect(screen.getByLabelText('Name')).toBeEnabled()
      expect(screen.queryByRole('region', { name: 'Create a new version' })).not.toBeInTheDocument()
      expect(screen.getByText(/Draft version 1\.1\.0 created/)).toBeVisible()

      const lifecycle = await screen.findByRole('region', {
        name: 'Draft lifecycle and publication',
      })
      const createdRow = (await within(lifecycle).findByText('1.1.0')).closest('tr')
      expect(createdRow).not.toBeNull()
      expect(within(createdRow as HTMLElement).getByText('Draft')).toBeVisible()
      expect(
        within(createdRow as HTMLElement).getByRole('button', { name: 'Check readiness' }),
      ).toBeVisible()
      expect(within(lifecycle).getByText('Immutable')).toBeVisible()
    })

    test('requires a version label before calling the API', async () => {
      const api = publishedApi()
      const user = userEvent.setup()
      renderEditor(api, { rulebookId: DRAFT.id })

      const panel = await screen.findByRole('region', { name: 'Create a new version' })
      await user.click(within(panel).getByRole('button', { name: 'Create new version' }))

      expect(within(panel).getByText('Enter a version label such as 1.1.0.')).toBeVisible()
      expect(api.createVersion).not.toHaveBeenCalled()
      expect(screen.getByLabelText('Name')).toBeDisabled()
    })

    test('surfaces a duplicate label conflict and keeps the published state', async () => {
      const api = publishedApi({
        createVersion: vi.fn(async () => {
          throw new CatalogApiError(
            'Version "1.0" already exists for this rulebook.',
            409,
            'conflict',
          )
        }),
      })
      const user = userEvent.setup()
      renderEditor(api, { rulebookId: DRAFT.id })

      const panel = await screen.findByRole('region', { name: 'Create a new version' })
      await user.type(within(panel).getByLabelText('New version label'), '1.0')
      await user.click(within(panel).getByRole('button', { name: 'Create new version' }))

      const alert = await within(panel).findByRole('alert')
      expect(alert).toHaveTextContent('The new version was not created')
      expect(alert).toHaveTextContent('already exists')
      expect(within(panel).getByLabelText('New version label')).toHaveValue('1.0')
      expect(
        screen.getByRole('heading', { name: 'Create a new version of PID Rulebook' }),
      ).toBeVisible()
      expect(screen.getByLabelText('Name')).toBeDisabled()
    })

    test('creates at most one version when the form is submitted repeatedly', async () => {
      const pending = deferred<RulebookVersion>()
      const api = publishedApi({ createVersion: vi.fn(() => pending.promise) })
      renderEditor(api, { rulebookId: DRAFT.id })

      const panel = await screen.findByRole('region', { name: 'Create a new version' })
      fireEvent.change(within(panel).getByLabelText('New version label'), {
        target: { value: '2.0' },
      })
      const form = within(panel).getByRole('button', { name: 'Create new version' }).closest('form')
      expect(form).not.toBeNull()
      fireEvent.submit(form as HTMLFormElement)
      fireEvent.submit(form as HTMLFormElement)

      expect(api.createVersion).toHaveBeenCalledTimes(1)
      await act(async () => {
        pending.resolve(version({ id: 'version-2-0', version: '2.0', status: 'draft' }))
      })
      expect(await screen.findByText(/Draft version 2\.0 created/)).toBeVisible()
    })

    test('keeps the typed label when the session expires', async () => {
      const api = publishedApi({
        createVersion: vi.fn(async () => {
          throw new CatalogApiError('Authentication is required.', 401)
        }),
      })
      const user = userEvent.setup()
      renderEditor(api, { rulebookId: DRAFT.id })

      const panel = await screen.findByRole('region', { name: 'Create a new version' })
      await user.type(within(panel).getByLabelText('New version label'), '1.1.0')
      await user.click(within(panel).getByRole('button', { name: 'Create new version' }))

      expect(await screen.findByRole('heading', { name: 'Sign in again' })).toBeVisible()
      expect(within(panel).getByLabelText('New version label')).toHaveValue('1.1.0')
      expect(screen.getByLabelText('Name')).toBeDisabled()
    })

    test('reports an ownership refusal without a sign-in prompt', async () => {
      const api = publishedApi({
        createVersion: vi.fn(async () => {
          throw new CatalogApiError(
            'The authenticated provider does not own this resource.',
            403,
            'forbidden',
          )
        }),
      })
      const user = userEvent.setup()
      renderEditor(api, { rulebookId: DRAFT.id })

      const panel = await screen.findByRole('region', { name: 'Create a new version' })
      await user.type(within(panel).getByLabelText('New version label'), '1.1.0')
      await user.click(within(panel).getByRole('button', { name: 'Create new version' }))

      expect(
        await within(panel).findByText('The authenticated provider does not own this resource.'),
      ).toBeVisible()
      expect(screen.queryByRole('heading', { name: 'Sign in again' })).not.toBeInTheDocument()
    })

    test('does not offer the next-version flow to another provider administrator', async () => {
      const api = publishedApi()
      renderEditor(api, {
        rulebookId: DRAFT.id,
        session: fakeSession({
          session: {
            ...TEST_SESSION,
            provider: { ...TEST_SESSION.provider, id: 'provider-other' },
          },
        }),
      })

      expect(await screen.findByText('This rulebook is published.')).toBeVisible()
      expect(screen.getByRole('heading', { name: 'Edit PID Rulebook draft' })).toBeVisible()
      expect(screen.queryByRole('region', { name: 'Create a new version' })).not.toBeInTheDocument()
      expect(screen.getByLabelText('Name')).toBeDisabled()
      expect(
        screen.getByText(/creating a new version needs the administrator of the provider/),
      ).toBeVisible()
    })

    test('has no detectable accessibility violations in the next-version flow', async () => {
      const api = publishedApi()
      const { container } = renderEditor(api, { rulebookId: DRAFT.id })

      await screen.findByRole('region', { name: 'Create a new version' })
      await expectNoA11yViolations(container)
    })
  })

  test('has no detectable accessibility violations', async () => {
    const api = editor()
    const { container } = renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    await waitFor(() => expect(api.validateDraft).toHaveBeenCalled())
    await screen.findByText('No validation findings.')
    await expectNoA11yViolations(container)
  })
})

describe('editor contextual help', () => {
  test('links the rulebook authoring guide in a new tab from the new-rulebook editor', async () => {
    renderEditor(editor())

    await screen.findByRole('heading', { name: 'New rulebook draft' })
    const link = screen.getByRole('link', { name: /rulebook authoring guide/i })
    expect(link).toHaveAttribute('href', '/guide/rulebook-authoring')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).toHaveAccessibleName(/rulebook authoring guide\s*\(opens in a new tab\)/)

    // Kernel of the UAT: the link is keyboard-reachable and leaves the form in place.
    link.focus()
    expect(link).toHaveFocus()
    expect(screen.getByLabelText('Name')).toBeEnabled()
  })

  test('links the credential schemas guide beside the attestation types', async () => {
    renderEditor(editor(), { rulebookId: DRAFT.id })

    const heading = await screen.findByRole('heading', { name: 'Attestation types' })
    const section = heading.closest('section')
    expect(section).not.toBeNull()

    const link = within(section as HTMLElement).getByRole('link', {
      name: /credential schemas guide/i,
    })
    expect(link).toHaveAttribute('href', '/guide/credential-schemas')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).toHaveAccessibleName(/credential schemas guide\s*\(opens in a new tab\)/)
  })
})
