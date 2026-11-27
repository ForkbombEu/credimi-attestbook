import type { AriaRole, ReactNode } from 'react'

export type AlertVariant = 'success' | 'warning' | 'destructive' | 'info'

/** Lucide glyphs named by DESIGN.md §11 Alerts, one per variant. */
const ICON_PATHS: Record<AlertVariant, ReactNode> = {
  success: (
    <>
      <path d="M18 6 7 17l-5-5" />
      <path d="m22 10-7.5 7.5L13 16" />
    </>
  ),
  warning: (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  destructive: (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>
  ),
}

interface AlertProps {
  readonly variant: AlertVariant
  /** The 500/16 title line; omitted for a one-sentence alert. */
  readonly title?: ReactNode
  /** Keeps a title that is a heading in the page outline at its level. */
  readonly titleAs?: 'p' | 'h2' | 'h3'
  readonly role?: AriaRole
  /** One trailing control, such as a Retry button, at the end of the row. */
  readonly action?: ReactNode
  readonly className?: string
  readonly children?: ReactNode
}

/**
 * The shared Credimi alert (DESIGN.md §11, `.alert` in `brand/style.css`): a
 * bordered row in its variant's colour with an 18px icon, an optional title,
 * the body and an optional action. Failures and hints go here, never to an
 * output box in the page.
 */
export function Alert({
  variant,
  title,
  titleAs: Title = 'p',
  role,
  action,
  className,
  children,
}: AlertProps) {
  return (
    <div
      className={`alert alert-${variant}${className === undefined ? '' : ` ${className}`}`}
      role={role}
    >
      <svg className="alert-icon" viewBox="0 0 24 24" aria-hidden="true">
        {ICON_PATHS[variant]}
      </svg>
      <div className="alert-content">
        {title === undefined ? null : <Title className="alert-title">{title}</Title>}
        {children === undefined ? null : <div className="alert-body">{children}</div>}
      </div>
      {action === undefined ? null : <div className="alert-action">{action}</div>}
    </div>
  )
}
