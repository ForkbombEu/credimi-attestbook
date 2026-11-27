/** Public path of the installed Credimi brand stylesheet (`ui/public/brand/`). */
export const BRAND_STYLESHEET_PATH = '/brand/style.css'

/**
 * Pins the entry document's brand-stylesheet link to the stylesheet's content
 * version. The `/brand/` files keep stable, unhashed paths (DESIGN.md runtime
 * copy) and are cached for an hour, so without a version a deploy that changes
 * the stylesheet would pair new markup with the previous, cached rules.
 */
export function versionBrandStylesheet(html: string, version: string): string {
  const link = `href="${BRAND_STYLESHEET_PATH}"`
  if (!html.includes(link)) {
    throw new Error(`the entry document must link the brand stylesheet at ${BRAND_STYLESHEET_PATH}`)
  }
  return html.replace(link, `href="${BRAND_STYLESHEET_PATH}?v=${encodeURIComponent(version)}"`)
}
