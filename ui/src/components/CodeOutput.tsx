/**
 * Credimi's class contract for JSON and code output (DESIGN.md §6 "JSON and
 * code output"). `code-display-scroller` gives the utility-class names their
 * layout in `brand/style.css`, so no utility-CSS framework is needed.
 */
export const CODE_OUTPUT_CLASS =
  'shiki catppuccin-frappe p-4 w-full min-h-0 grow h-full overflow-auto code-display-scroller scrollbar-on-dark text-sm transition-all max-h-[350px]'

/** A focusable, scrollable Catppuccin Frappé block for JSON or source output. */
export function CodeOutput({
  label,
  children,
}: {
  readonly label: string
  readonly children: string
}) {
  return (
    <pre className={CODE_OUTPUT_CLASS} tabIndex={0} aria-label={label}>
      <code>{children}</code>
    </pre>
  )
}
