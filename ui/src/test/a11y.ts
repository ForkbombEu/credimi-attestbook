import axe from 'axe-core'
import { expect } from 'vitest'

/**
 * Runs axe-core over a rendered container. Colour contrast is disabled because
 * jsdom does not compute layout or painted colours; the Playwright end-to-end
 * test runs the full rule set in a real browser.
 */
export async function expectNoA11yViolations(container: Element): Promise<void> {
  const results = await axe.run(container, {
    rules: {
      'color-contrast': { enabled: false },
    },
  })
  const summary = results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} (${violation.nodes
        .map((node) => node.target.join(' '))
        .join(', ')})`,
  )
  expect(summary).toEqual([])
}
