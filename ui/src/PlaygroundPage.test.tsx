import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { CatalogApiError, type CatalogApi, type ValidationApi } from './api'
import { PlaygroundPage } from './PlaygroundPage'
import {
  createFakeApi,
  createFakeValidator,
  makeFailedValidationResult,
  makeValidationResult,
  SAMPLE_DATASET,
} from './test/fixtures'
import { expectNoA11yViolations } from './test/a11y'

function renderPlayground(
  api: CatalogApi = createFakeApi(),
  validator: ValidationApi = createFakeValidator(),
) {
  const onNavigate = vi.fn()
  const view = render(<PlaygroundPage api={api} validator={validator} onNavigate={onNavigate} />)
  return { ...view, onNavigate }
}

async function selectRulebook(
  user: ReturnType<typeof userEvent.setup>,
  rulebookName = 'PID Rulebook',
) {
  await user.selectOptions(await screen.findByLabelText('Rulebook'), rulebookName)
  await screen.findByRole('option', { name: '1.0 · Published' })
  await user.selectOptions(screen.getByLabelText('Rulebook version'), '1.0')
  await user.selectOptions(screen.getByLabelText('Attestation type'), 'Person Identification Data')
}

describe('playground rulebook loading', () => {
  test('shows a loading state while the rulebooks are requested', () => {
    const pending: CatalogApi = {
      listProviders: () => new Promise(() => {}),
      listRulebooks: () => new Promise(() => {}),
      getRulebook: () => new Promise(() => {}),
      listAttestations: () => new Promise(() => {}),
      listSchemaReferences: () => new Promise(() => {}),
      listVersions: () => new Promise(() => {}),
      getVersionSchemaReferences: () => new Promise(() => {}),
      getVersionDiff: () => new Promise(() => {}),
    }
    renderPlayground(pending)

    expect(screen.getByRole('status')).toHaveTextContent('Loading rulebooks…')
  })

  test('shows a load error and retries the rulebook request', async () => {
    const user = userEvent.setup()
    const api = createFakeApi()
    let attempts = 0
    const flaky: CatalogApi = {
      ...api,
      listRulebooks: async (signal) => {
        attempts += 1
        if (attempts === 1) {
          throw new Error('The rulebook registry is not configured on this server.')
        }
        return api.listRulebooks(signal)
      },
    }
    renderPlayground(flaky)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The rulebooks could not be loaded.')
    expect(alert).toHaveTextContent('The rulebook registry is not configured on this server.')

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByLabelText('Rulebook')).toBeInTheDocument()
    expect(attempts).toBe(2)
  })

  test('keeps the rulebook selector usable when the API page is truncated', async () => {
    const truncated: CatalogApi = {
      ...createFakeApi(),
      listRulebooks: async () => ({
        data: SAMPLE_DATASET.rulebooks,
        pagination: { limit: 100, offset: 0, total: 140 },
      }),
    }
    renderPlayground(truncated)

    expect(
      await screen.findByText(
        'Showing the first 2 of 140 rulebooks; the rulebook selector covers only these 2.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Rulebook')).toBeInTheDocument()
  })

  test('shows an empty state when no rulebook is registered', async () => {
    const empty: CatalogApi = {
      ...createFakeApi(),
      listRulebooks: async () => ({
        data: [],
        pagination: { limit: 100, offset: 0, total: 0 },
      }),
    }
    renderPlayground(empty)

    expect(await screen.findByText('No rulebooks yet')).toBeInTheDocument()
    expect(screen.queryByLabelText('Rulebook')).not.toBeInTheDocument()
  })
})

describe('playground request form', () => {
  test('loads versions and attestation types only after a rulebook is selected', async () => {
    const user = userEvent.setup()
    renderPlayground()

    const rulebook = await screen.findByLabelText('Rulebook')
    expect(screen.getByLabelText('Rulebook version')).toBeDisabled()
    expect(screen.getByLabelText('Attestation type')).toBeDisabled()

    await user.selectOptions(rulebook, 'rulebook-pid')

    expect(await screen.findByRole('option', { name: '1.0 · Published' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '1.1 · Draft' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Person Identification Data' })).toBeInTheDocument()
    expect(screen.getByLabelText('Rulebook version')).toBeEnabled()
    expect(screen.getByLabelText('Attestation type')).toBeEnabled()
  })

  test('surfaces a related rulebook read failure and retries it', async () => {
    const user = userEvent.setup()
    const api = createFakeApi()
    let attempts = 0
    const flaky: CatalogApi = {
      ...api,
      listVersions: async (rulebookId, signal) => {
        attempts += 1
        if (attempts === 1) {
          throw new Error('The rulebook registry is not configured on this server.')
        }
        return api.listVersions(rulebookId, signal)
      },
    }
    renderPlayground(flaky)

    await user.selectOptions(await screen.findByLabelText('Rulebook'), 'rulebook-pid')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'The rulebook versions or attestation types could not be loaded.',
    )
    expect(alert).toHaveTextContent('The rulebook registry is not configured on this server.')

    await user.click(screen.getByRole('button', { name: 'Retry rulebook details' }))
    expect(await screen.findByRole('option', { name: '1.0 · Published' })).toBeInTheDocument()
    expect(attempts).toBe(2)
  })

  test('rejects an incomplete request without calling the validation API', async () => {
    const user = userEvent.setup()
    const validateCredential = vi.fn()
    renderPlayground(createFakeApi(), { validateCredential })
    await screen.findByLabelText('Rulebook')

    await user.click(screen.getByRole('button', { name: 'Run validation' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Check the request before running validation')
    expect(alert).toHaveTextContent('Select a rulebook.')
    expect(alert).toHaveTextContent('Paste or upload a credential.')
    expect(validateCredential).not.toHaveBeenCalled()
  })

  test('loads a credential from an uploaded file and records an oversized-file error', async () => {
    const user = userEvent.setup()
    renderPlayground()
    await screen.findByLabelText('Rulebook')

    const upload = screen.getByLabelText('Upload a credential file')
    await user.upload(upload, new File(['header.payload.signature'], 'credential.txt'))

    await waitFor(() =>
      expect(screen.getByLabelText('Credential')).toHaveValue('header.payload.signature'),
    )

    const oversized = new File(['a'.repeat(512 * 1024 + 1)], 'oversized.txt')
    await user.upload(upload, oversized)

    expect(screen.getByText('The selected file is larger than 512 KiB.')).toBeInTheDocument()
  })

  test('ignores a file read that finishes after the form was cleared', async () => {
    const user = userEvent.setup()
    renderPlayground()
    await screen.findByLabelText('Rulebook')

    let resolveRead: (text: string) => void = () => undefined
    const file = new File(['late'], 'late.txt', { type: 'text/plain' })
    Object.defineProperty(file, 'text', {
      value: () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve
        }),
    })

    await user.upload(screen.getByLabelText('Upload a credential file'), file)
    await user.click(screen.getByRole('button', { name: 'Clear form' }))

    await act(async () => {
      resolveRead('late credential text')
      await Promise.resolve()
    })

    expect(screen.getByLabelText('Credential')).toHaveValue('')
  })

  test('recovers from a running validation when the chosen file is rejected', async () => {
    const user = userEvent.setup()
    const pendingValidator: ValidationApi = {
      validateCredential: () => new Promise(() => {}),
    }
    renderPlayground(createFakeApi(), pendingValidator)

    await selectRulebook(user)
    await user.type(screen.getByLabelText('Credential'), 'header.payload.signature')
    await user.click(screen.getByRole('button', { name: 'Run validation' }))
    expect(screen.getByRole('button', { name: 'Validating…' })).toBeDisabled()

    await user.upload(
      screen.getByLabelText('Upload a credential file'),
      new File(['a'.repeat(512 * 1024 + 1)], 'oversized.txt'),
    )

    expect(await screen.findByRole('button', { name: 'Run validation' })).toBeEnabled()
    expect(screen.getByText('The selected file is larger than 512 KiB.')).toBeInTheDocument()
  })

  test('applies a pending file read after changing a rulebook selection', async () => {
    const user = userEvent.setup()
    renderPlayground()
    await screen.findByLabelText('Rulebook')

    let resolveRead: (text: string) => void = () => undefined
    const file = new File(['late'], 'late.txt', { type: 'text/plain' })
    Object.defineProperty(file, 'text', {
      value: () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve
        }),
    })

    await user.upload(screen.getByLabelText('Upload a credential file'), file)
    await user.selectOptions(screen.getByLabelText('Rulebook'), 'rulebook-age')

    await act(async () => {
      resolveRead('file credential text')
      await Promise.resolve()
    })

    expect(screen.getByLabelText('Credential')).toHaveValue('file credential text')
  })

  test('clears the form and any displayed result', async () => {
    const user = userEvent.setup()
    renderPlayground()
    await selectRulebook(user)
    await user.type(screen.getByLabelText('Credential'), 'header.payload.signature')
    await user.click(screen.getByRole('button', { name: 'Run validation' }))
    expect(await screen.findByText('Overall result')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear form' }))

    expect(screen.getByLabelText('Rulebook')).toHaveValue('')
    expect(screen.getByLabelText('Credential')).toHaveValue('')
    expect(screen.queryByText('Overall result')).not.toBeInTheDocument()
  })
})

describe('playground validation results', () => {
  test('sends the real request and reports untested dimensions and limitations', async () => {
    const user = userEvent.setup()
    const validateCredential = vi.fn().mockResolvedValue(makeValidationResult())
    renderPlayground(createFakeApi(), { validateCredential })

    await selectRulebook(user)
    await user.type(screen.getByLabelText('Credential'), '  header.payload.signature~disc  ')
    await user.click(screen.getByRole('button', { name: 'Run validation' }))

    expect(await screen.findByText('Overall result')).toBeInTheDocument()

    expect(validateCredential).toHaveBeenCalledTimes(1)
    expect(validateCredential.mock.calls[0]?.[0]).toEqual({
      rulebookId: 'rulebook-pid',
      rulebookVersion: '1.0',
      attestationType: 'Person Identification Data',
      credential: 'header.payload.signature~disc',
    })
    expect(validateCredential.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)

    const dimensions = screen.getByRole('region', { name: 'Validation dimensions' })
    expect(within(dimensions).getAllByRole('row')).toHaveLength(9)
    expect(within(dimensions).getByText('Credential parsing')).toBeInTheDocument()
    expect(within(dimensions).getByText('Cryptographic verification')).toBeInTheDocument()
    expect(within(dimensions).getByText('End-to-end interoperability')).toBeInTheDocument()
    expect(within(dimensions).getAllByText('Not executed').length).toBeGreaterThan(0)
    expect(within(dimensions).getAllByText('Not applicable').length).toBeGreaterThan(0)
    expect(within(dimensions).getAllByText('Not tested').length).toBe(3)

    expect(screen.getByText('Untested dimensions are not passes.')).toBeInTheDocument()
    expect(screen.getByText(/3 of 6 applicable dimensions did not execute/)).toBeInTheDocument()

    const violations = screen.getByRole('region', { name: 'Violations' })
    expect(violations).toHaveTextContent('No violations were reported.')

    const limitations = screen.getByRole('region', { name: 'Limitations of this result' })
    expect(limitations).toHaveTextContent('Issuer signatures, KB-JWT proofs')
    expect(limitations).toHaveTextContent('No trust anchors were applied.')
    expect(limitations).toHaveTextContent('protocol_conformance_not_applicable')
  })

  test('inspects an individual violation when a validation dimension fails', async () => {
    const user = userEvent.setup()
    renderPlayground(createFakeApi(), createFakeValidator(makeFailedValidationResult()))

    await selectRulebook(user)
    await user.type(screen.getByLabelText('Credential'), 'header.payload.signature')
    await user.click(screen.getByRole('button', { name: 'Run validation' }))

    expect(await screen.findByText('Overall result')).toBeInTheDocument()
    expect(screen.getAllByText('Failed').length).toBeGreaterThan(0)
    expect(screen.getByText(/This credential is not valid/)).toBeInTheDocument()

    const violations = screen.getByRole('region', { name: 'Violations' })
    expect(violations).toHaveTextContent('format_not_supported_by_rulebook')
    expect(violations).toHaveTextContent(
      'The selected attestation type does not support the "dc+sd-jwt" credential format.',
    )
    expect(violations).toHaveTextContent('format is one of mso_mdoc')
    expect(violations).toHaveTextContent('/credential')
  })

  test('shows the safe API error, keeps the credential and retries without leaking it', async () => {
    const user = userEvent.setup()
    const validateCredential = vi
      .fn()
      .mockRejectedValueOnce(new CatalogApiError('The credential must be a string', 400))
      .mockResolvedValueOnce(makeValidationResult())
    renderPlayground(createFakeApi(), { validateCredential })

    await selectRulebook(user)
    await user.type(screen.getByLabelText('Credential'), 'header.payload.signature')
    await user.click(screen.getByRole('button', { name: 'Run validation' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The validation request failed.')
    expect(alert).toHaveTextContent('The credential must be a string')
    expect(alert).not.toHaveTextContent('header.payload.signature')
    expect(screen.getByLabelText('Credential')).toHaveValue('header.payload.signature')

    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Overall result')).toBeInTheDocument()
    expect(validateCredential).toHaveBeenCalledTimes(2)
  })

  test('exports the typed result as a JSON download without the credential', async () => {
    const user = userEvent.setup()
    const captured: Blob[] = []
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: (blob: Blob) => {
        captured.push(blob)
        return 'blob:validation-result'
      },
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: () => undefined,
    })
    const clicked: HTMLAnchorElement[] = []
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this)
    })

    try {
      renderPlayground()
      await selectRulebook(user)
      await user.type(screen.getByLabelText('Credential'), 'secret-credential-artifact')
      await user.click(screen.getByRole('button', { name: 'Run validation' }))
      await screen.findByText('Overall result')

      await user.click(screen.getByRole('button', { name: 'Export result (JSON)' }))

      await waitFor(() => expect(captured).toHaveLength(1))
      const text = await captured[0]!.text()
      const exported = JSON.parse(text) as { overallStatus: string; validationId: string }
      expect(exported.overallStatus).toBe('NOT_TESTED')
      expect(exported.validationId).toBe('validation-0001')
      expect(text).not.toContain('secret-credential-artifact')

      expect(clicked[0]?.download).toBe('attestbook-validation-validation-0001.json')
      expect(clicked[0]?.href).toBe('blob:validation-result')
      expect(
        screen.getByText(/The result was exported as JSON\./, { exact: false }),
      ).toBeInTheDocument()
    } finally {
      clickSpy.mockRestore()
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: originalCreate,
      })
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: originalRevoke,
      })
    }
  })

  test('has no detectable accessibility violations on the form and the result', async () => {
    const user = userEvent.setup()
    const { container } = renderPlayground()

    await selectRulebook(user)
    await expectNoA11yViolations(container)

    await user.type(screen.getByLabelText('Credential'), 'header.payload.signature')
    await user.click(screen.getByRole('button', { name: 'Run validation' }))
    await screen.findByText('Overall result')

    await expectNoA11yViolations(container)
  })

  test('keeps the same sample dataset as the catalog', () => {
    // Guards against a fixture drift that would make the cascade test vacuous.
    expect(SAMPLE_DATASET.versions['rulebook-pid']?.map((version) => version.version)).toEqual([
      '1.0',
      '1.1',
    ])
  })
})
