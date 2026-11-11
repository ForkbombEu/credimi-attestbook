import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

/**
 * The Credimi brand directory is a runtime copy of the canonical template
 * assets (DESIGN.md §1). Pinning the logo and font bytes keeps an edit from
 * silently drifting from the published brand, and the link assertions keep the
 * stylesheet order and the "no external CDN" constraint honest.
 */
const root = existsSync(resolve(process.cwd(), 'ui/index.html'))
  ? process.cwd()
  : resolve(process.cwd(), '..')
const brand = join(root, 'ui/public/brand')
const indexHtml = join(root, 'ui/index.html')
const mainEntry = join(root, 'ui/src/main.tsx')
const appStylesheet = join(root, 'ui/src/styles.css')

const LOGO_SHA256: Record<string, string> = {
  'logos/credimi_logo.svg': '031885760a9165e9d8d49eab45baca30ba5ed8dd1fbf0b4699fba2de5dc4feac',
  'logos/credimi_logo_negative.svg':
    '32df33f9f5ffa696d452e1f65f5d6738b920415c5114db4b010af1f997a8cb3a',
  'logos/credimi_logo-transp.svg':
    '8407a3ed0beddc137599f71498f1ca8e68766a2684dba80093ea25e17173eef7',
  'logos/credimi_logo-transp_white.svg':
    '196017744fca7d3836720995aca8c55c8531908e8dcdafc5ca5e7b48ef8f7e10',
}

const FONT_SHA256: Record<string, string> = {
  'fonts/InterVariable.ttf': '29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031',
  'fonts/SourceCodeProVariable.ttf':
    'b400fc584e10aff25d0e775ce181b4fc1c5ea1b5dc37b81aeb2084375b945790',
}

function sha256(relative: string): string {
  return createHash('sha256')
    .update(readFileSync(join(brand, relative)))
    .digest('hex')
}

describe('Credimi brand assets', () => {
  test.each(Object.entries(LOGO_SHA256))('%s is the canonical logo', (relative, digest) => {
    expect(sha256(relative)).toBe(digest)
  })

  test.each(Object.entries(FONT_SHA256))('%s is the canonical font', (relative, digest) => {
    expect(sha256(relative)).toBe(digest)
  })

  test('the brand stylesheet declares the two self-hosted families', () => {
    const stylesheet = readFileSync(join(brand, 'style.css'), 'utf8')

    expect(stylesheet).toContain("font-family: 'Inter'")
    expect(stylesheet).toContain("font-family: 'Source Code Pro'")
    expect(stylesheet).toContain("url('fonts/InterVariable.ttf')")
    expect(stylesheet).toContain("url('fonts/SourceCodeProVariable.ttf')")
    expect(existsSync(join(brand, 'fonts/InterVariable.OFL.txt'))).toBe(true)
    expect(existsSync(join(brand, 'fonts/SourceCodeProVariable.OFL.txt'))).toBe(true)
  })

  test('the entry document loads the brand stylesheet before the application', () => {
    const html = readFileSync(indexHtml, 'utf8')
    const brandLink = html.indexOf('href="/brand/style.css"')

    expect(brandLink).toBeGreaterThan(-1)
    expect(html.indexOf('/src/main.tsx')).toBeGreaterThan(brandLink)
    expect(readFileSync(mainEntry, 'utf8')).toContain("import './styles.css'")
  })

  test('loads no external web assets', () => {
    for (const text of [
      readFileSync(indexHtml, 'utf8'),
      readFileSync(appStylesheet, 'utf8'),
      readFileSync(join(brand, 'style.css'), 'utf8'),
    ]) {
      expect(text).not.toMatch(/(?:src|href)=["']https?:\/\//)
      expect(text).not.toMatch(/url\(\s*["']?https?:\/\//)
      expect(text).not.toMatch(/@import\s+(?:url\()?["']?https?:\/\//)
    }
  })
})
