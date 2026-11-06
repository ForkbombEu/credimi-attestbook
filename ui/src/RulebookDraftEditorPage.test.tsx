import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { CatalogApiError, type EditorApi } from './api'
import { RulebookDraftEditorPage } from './RulebookDraftEditorPage'
import { expectNoA11yViolations } from './test/a11y'
import type {
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
    readonly token?: string
    readonly onTokenChange?: (token: string) => void
    readonly onNavigate?: (path: string) => void
  } = {},
) {
  return render(
    <RulebookDraftEditorPage
      api={api}
      {...(options.rulebookId === undefined ? {} : { rulebookId: options.rulebookId })}
      token={options.token ?? ''}
      onTokenChange={options.onTokenChange ?? (() => {})}
      onNavigate={options.onNavigate ?? (() => {})}
    />,
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

  test('saves with the provider bearer token', async () => {
    const api = editor()
    const user = userEvent.setup()
    const saved = { ...DRAFT, description: 'Updated' }
    api.replaceDraft = vi.fn(async () => saved)
    renderEditor(api, { rulebookId: DRAFT.id, token: 'att_secret' })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    await waitFor(() => expect(api.validateDraft).toHaveBeenCalled())
    await screen.findByText('No validation findings.')
    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    await waitFor(() => expect(api.replaceDraft).toHaveBeenCalled())
    expect(api.replaceDraft).toHaveBeenCalledWith(
      DRAFT.id,
      expect.objectContaining({ name: 'PID Rulebook', applicableSpec: 'ts11@1.0.1' }),
      'att_secret',
    )
    expect(await screen.findByText(/Draft saved at/)).toBeVisible()
  })

  test('requires a token before saving and never calls the write', async () => {
    const api = editor()
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    await waitFor(() => expect(api.validateDraft).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    expect(
      await screen.findByText('Enter the owning provider’s bearer token to save this draft.'),
    ).toBeVisible()
    expect(api.replaceDraft).not.toHaveBeenCalled()
  })

  test('creates a new draft and navigates to its editor', async () => {
    const api = editor()
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    renderEditor(api, { token: 'att_secret', onNavigate })

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

  test('reports the token change to its owner without persisting it', async () => {
    const api = editor()
    const user = userEvent.setup()
    const onTokenChange = vi.fn()
    renderEditor(api, { rulebookId: DRAFT.id, onTokenChange })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    const tokenInput = screen.getByLabelText('Provider bearer token')
    expect(tokenInput).toHaveAttribute('type', 'password')
    await user.type(tokenInput, 'att_')
    expect(onTokenChange).toHaveBeenCalled()
  })

  test('gates publish on readiness and reports the published status', async () => {
    const api = editor()
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id, token: 'att_secret' })

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
      expect(api.publishVersion).toHaveBeenCalledWith(DRAFT.id, '1.0', 'att_secret'),
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
    renderEditor(api, { rulebookId: DRAFT.id, token: 'att_secret' })

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
    renderEditor(api, { rulebookId: DRAFT.id, token: 'att_secret' })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    const lifecycle = await screen.findByRole('region', {
      name: 'Draft lifecycle and publication',
    })
    expect(within(lifecycle).getByText(/No versions have been frozen/)).toBeVisible()

    await user.type(within(lifecycle).getByLabelText('New version label'), '2.0')
    await user.click(within(lifecycle).getByRole('button', { name: 'Freeze as draft version' }))

    await waitFor(() =>
      expect(api.createVersion).toHaveBeenCalledWith(DRAFT.id, '2.0', 'att_secret'),
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
    renderEditor(api, { rulebookId: DRAFT.id, token: 'att_secret' })

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

  test('requires a token before a lifecycle write', async () => {
    const api = editor()
    const user = userEvent.setup()
    renderEditor(api, { rulebookId: DRAFT.id })

    await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' })
    const lifecycle = await screen.findByRole('region', {
      name: 'Draft lifecycle and publication',
    })
    await user.type(within(lifecycle).getByLabelText('New version label'), '2.0')
    await user.click(within(lifecycle).getByRole('button', { name: 'Freeze as draft version' }))

    expect(
      await within(lifecycle).findByText(
        'Enter the owning provider’s bearer token to change the draft lifecycle.',
      ),
    ).toBeVisible()
    expect(api.createVersion).not.toHaveBeenCalled()
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
