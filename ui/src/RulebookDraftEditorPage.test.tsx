import { useState } from 'react'

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
    expect((screen.getByLabelText('Draft JSON') as HTMLTextAreaElement).value).toContain(
      '"attestations"',
    )

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

  test('reports invalid JSON immediately and disables saving', async () => {
    const api = editor()
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    const json = await screen.findByLabelText('Draft JSON')
    await user.clear(json)
    await user.type(json, '{{')

    expect(await screen.findByText('The JSON editor does not contain valid JSON.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled()
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
    expect(screen.queryByLabelText('Draft JSON')).not.toBeInTheDocument()
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
    expect(screen.getByLabelText('Draft JSON')).toBeDisabled()
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
    expect(publish).toBeEnabled()

    await user.click(publish)
    await waitFor(() =>
      expect(api.publishVersion).toHaveBeenCalledWith(DRAFT.id, '1.0', 'csrf-token-value'),
    )
    expect(await within(lifecycle).findByText(/is now published and immutable/)).toBeVisible()
    expect(screen.getByText('This rulebook is published.')).toBeVisible()
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

  test('registers a pasted hosted schema and inserts its URI and integrity into the Draft JSON', async () => {
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
    const json = screen.getByLabelText('Draft JSON') as HTMLTextAreaElement
    expect(json.value).toContain(REGISTERED.url)
    expect(json.value).toContain(REGISTERED.integrity)
  })

  test('inserts a registered schema into the latest Draft JSON, not the click-time copy', async () => {
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

    // The Draft JSON stays editable while the registration is in flight.
    const json = screen.getByLabelText('Draft JSON') as HTMLTextAreaElement
    const edited = JSON.parse(json.value) as Record<string, unknown>
    edited.xNote = 'kept'
    fireEvent.change(json, { target: { value: JSON.stringify(edited, null, 2) } })

    await act(async () => {
      pending.resolve(REGISTERED)
      await pending.promise
    })

    await waitFor(() =>
      expect((screen.getByLabelText('Draft JSON') as HTMLTextAreaElement).value).toContain(
        '"xNote": "kept"',
      ),
    )
    const saved = JSON.parse(
      (screen.getByLabelText('Draft JSON') as HTMLTextAreaElement).value,
    ) as {
      xNote: string
      attestations: readonly { schemaReferences: readonly unknown[] }[]
    }
    expect(saved.xNote).toBe('kept')
    expect(saved.attestations[0]?.schemaReferences).toContainEqual({
      formatIdentifier: 'dc+sd-jwt',
      uri: REGISTERED.url,
      integrity: REGISTERED.integrity,
    })
    expect(
      await screen.findByText('Hosted schema registered and added to the draft.'),
    ).toBeVisible()
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

    const json = screen.getByLabelText('Draft JSON') as HTMLTextAreaElement
    const edited = JSON.parse(json.value) as {
      attestations: { name: string; schemaReferences: readonly unknown[] }[]
    }
    edited.attestations[0]!.name = 'Renamed Attestation'
    fireEvent.change(json, { target: { value: JSON.stringify(edited, null, 2) } })

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

    const saved = JSON.parse(
      (screen.getByLabelText('Draft JSON') as HTMLTextAreaElement).value,
    ) as {
      attestations: readonly { name: string; schemaReferences: readonly { uri: string }[] }[]
    }
    expect(saved.attestations[0]?.name).toBe('Renamed Attestation')
    expect(saved.attestations[0]?.schemaReferences.map((reference) => reference.uri)).not.toContain(
      REGISTERED.url,
    )
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
    const json = screen.getByLabelText('Draft JSON') as HTMLTextAreaElement
    expect(json.value).toContain('https://issuer.example.org/schemas/pid-v2')
    expect(json.value).toContain('sha256-NEWPINSHA256NEWPINSHA256NEWPINSHA256NEWPIN=')
  })

  test('keeps multiple attestations and formats unambiguous when inserting a schema', async () => {
    const twoAttestations: DraftRulebook = {
      ...DRAFT,
      attestations: [
        { ...DRAFT.attestations[0]!, name: 'Payment Account', schemaReferences: [] },
        { ...DRAFT.attestations[0]!, name: 'Account Details', schemaReferences: [] },
      ],
    }
    const api = editor({ getDraft: vi.fn(async () => twoAttestations) })
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

    const json = screen.getByLabelText('Draft JSON') as HTMLTextAreaElement
    const saved = JSON.parse(json.value) as {
      attestations: readonly { name: string; schemaReferences: readonly { uri: string }[] }[]
    }
    expect(saved.attestations[0]?.schemaReferences).toEqual([])
    expect(saved.attestations[1]?.schemaReferences).toEqual([
      {
        formatIdentifier: 'dc+sd-jwt',
        uri: 'https://issuer.example.org/schemas/account-details',
      },
    ])
  })

  test('disables the schema controls while the Draft JSON is invalid', async () => {
    const api = editor()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    fireEvent.change(screen.getByLabelText('Draft JSON'), { target: { value: '{not-json' } })

    expect(
      await screen.findByText('Fix the Draft JSON before editing schema references.'),
    ).toBeVisible()
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
    expect((screen.getByLabelText('Draft JSON') as HTMLTextAreaElement).value).not.toContain(
      REGISTERED.url,
    )
  })

  test('removes an existing schema reference from the Draft JSON', async () => {
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
    const json = screen.getByLabelText('Draft JSON') as HTMLTextAreaElement
    expect(
      (
        JSON.parse(json.value) as {
          attestations: readonly { schemaReferences: readonly unknown[] }[]
        }
      ).attestations[0]?.schemaReferences,
    ).toEqual([])
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

  test('has no detectable accessibility violations', async () => {
    const api = editor()
    const { container } = renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    await waitFor(() => expect(api.validateDraft).toHaveBeenCalled())
    await screen.findByText('No validation findings.')
    await expectNoA11yViolations(container)
  })
})
