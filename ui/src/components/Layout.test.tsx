import { render, screen, within } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import { expectNoA11yViolations } from '../test/a11y'
import { SiteFooter, SiteHeader } from './Layout'

const noop = () => {}

describe('Credimi Extras chrome', () => {
  test('renders the top banner before the header and links only the trailing word', () => {
    render(<SiteHeader section="Rulebook catalog" onNavigate={noop} />)

    const strip = screen.getByRole('complementary', { name: 'Credimi Extras' })
    expect(strip.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'This app is part of Credimi Extras. Automate all your EUDI testing with Credimi',
    )

    const links = within(strip).getAllByRole('link')
    expect(links).toHaveLength(1)
    const link = links[0]!
    expect(link).toHaveTextContent('Credimi')
    expect(link).toHaveAttribute('href', 'https://credimi.io')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noopener')

    const header = screen.getByRole('banner')
    expect(strip.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(header).getByRole('img', { name: 'Credimi' })).toHaveAttribute(
      'src',
      '/brand/logos/credimi_logo-transp.svg',
    )
    expect(within(header).getByRole('link', { name: 'Catalog' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  test('renders the footer strip with the wordmark as its only link', () => {
    render(<SiteFooter />)

    const footer = screen.getByRole('contentinfo')
    expect(footer).toHaveTextContent('AttestBook does not test or claim trust')

    const links = within(footer).getAllByRole('link')
    expect(links).toHaveLength(1)
    const link = links[0]!
    expect(link).toHaveAccessibleName('Credimi')
    expect(link).toHaveAttribute('href', 'https://credimi.io')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(within(link).getByRole('img')).toHaveAttribute(
      'src',
      '/brand/logos/credimi_logo-transp_white.svg',
    )
  })

  test('has no detectable accessibility violations', async () => {
    render(
      <>
        <SiteHeader section="Capture explorer" onNavigate={noop} />
        <main />
        <SiteFooter />
      </>,
    )

    await expectNoA11yViolations(document.body)
  })
})
