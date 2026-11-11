# Credimi — Brand & Design Guidelines

> **Credimi** is the trustworthy compliance checker for decentralized identity
> solutions, built and operated by **Forkbomb BV** (Amsterdam) under the NGI
> TRUSTCHAIN programme.

This document is the brand reference for every Credimi Extra: product
designers, marketers, agency partners, and engineers writing components.

**Source of truth.** The canonical brand specification is the Credimi Design
System project at
<https://claude.ai/design/p/019e1703-03a5-73c9-9db0-028f11767c3f>. This file is
that specification adapted to this template. When the two disagree, the design
system wins and this file is the thing that needs fixing.

**One place for assets.** Everything a derived application needs lives in
[`brand/`](brand/): one stylesheet, the fonts it declares, and the logos. There
is no second token file to reconcile against and no frozen stylesheet to
override — [§16](#16-merge-record) records how that came to be.

**AttestBook runtime copy.** The derived application installs the canonical
`brand/` directory at [`ui/public/brand/`](ui/public/brand/), served unchanged
at `/brand/` (stylesheet `/brand/style.css`, fonts `/brand/fonts/`, logos
`/brand/logos/`). `ui/index.html` loads `/brand/style.css` first and the
application's own stylesheet after it.

---

## Table of contents

1. [Canonical assets](#1-canonical-assets)
2. [Brand principles](#2-brand-principles)
3. [Voice & tone](#3-voice--tone)
4. [Logo](#4-logo)
5. [Color](#5-color)
6. [Typography](#6-typography)
7. [Spacing, radii, elevation](#7-spacing-radii-elevation)
8. [Layout & grid](#8-layout--grid)
9. [Iconography & illustration](#9-iconography--illustration)
10. [Motion](#10-motion)
11. [Components](#11-components)
12. [Patterns](#12-patterns)
13. [Credimi Extras cross-promotional banner](#13-credimi-extras-cross-promotional-banner)
14. [Chips and badges](#14-chips-and-badges)
15. [Do & Don't](#15-do--dont)
16. [Merge record](#16-merge-record)

---

## 1. Canonical assets

```
brand/
├── style.css                        the brand stylesheet — load this first
├── fonts/
│   ├── InterVariable.ttf            + InterVariable.OFL.txt
│   └── SourceCodeProVariable.ttf    + SourceCodeProVariable.OFL.txt
└── logos/
    ├── credimi_logo.svg             mark, dark      (also the favicon)
    ├── credimi_logo_negative.svg    mark, negative
    ├── credimi_logo-transp.svg      wordmark, dark
    └── credimi_logo-transp_white.svg  wordmark, white
```

### Frozen — logos

The four logo SVGs are human-supplied and must not be modified, regenerated,
optimized, or converted:

| Canonical asset | SHA-256 |
| --- | --- |
| `brand/logos/credimi_logo.svg` | `031885760a9165e9d8d49eab45baca30ba5ed8dd1fbf0b4699fba2de5dc4feac` |
| `brand/logos/credimi_logo_negative.svg` | `32df33f9f5ffa696d452e1f65f5d6738b920415c5114db4b010af1f997a8cb3a` |
| `brand/logos/credimi_logo-transp.svg` | `8407a3ed0beddc137599f71498f1ca8e68766a2684dba80093ea25e17173eef7` |
| `brand/logos/credimi_logo-transp_white.svg` | `196017744fca7d3836720995aca8c55c8531908e8dcdafc5ca5e7b48ef8f7e10` |

Add tests that prove each runtime copy is byte-for-byte equal to its canonical
original. Do not generate PNG or ICO logo variants. Use `credimi_logo.svg`
directly as the favicon, served from a stable same-origin path such as
`/favicon.svg`.

### Maintained — stylesheet and fonts

`brand/style.css` is **not** frozen. It is the merge of the former
`HITL/style.css` with the design system's `colors_and_type.css`
([§16](#16-merge-record)), and it is the file to edit when the brand moves.
Changing it means changing the brand, so it needs the same Design +
Engineering sign-off as any palette change.

`brand/fonts/` holds the two brand families as variable TTFs, each next to its
SIL OFL 1.1 license. `style.css` declares them with relative `url()`, so a
runtime copy must keep `fonts/` as a sibling of `style.css`.

Each derived web application installs runtime copies of all of the above, loads
its own application CSS **after** `brand/style.css`, and applies this branding
to every HTML page, including API documentation.

The chosen stack determines the runtime asset locations. Record those locations
in the derived project's `SPECS.md`; this template intentionally does not
prescribe paths.

---

## 2. Brand principles

Credimi sits in a serious, technical, EU-regulated market. The brand reflects
that — but it should never feel **bureaucratic**, **cold**, or **opaque**.

| Principle | What it means in practice |
|---|---|
| **Calm, not corporate** | Generous whitespace, restrained color, no exclamation marks. A reader should feel like they're in expert hands, not a sales funnel. |
| **Honest about complexity** | We don't simplify domain language ("conformance", "OID4VCI Draft 13", "mDoc"). We do explain it inline when context demands. |
| **Numbers earn their place** | Stats, scores, percentages, dates appear unsoftened (`80% compliant`, `20 over 30 tests passed`, `24/04/2026`). Never round, never hide. |
| **Evidence over claims** | Status chips, scoreboards, audit trails — design surfaces verifiable facts, not adjectives. |
| **EU-formal, not EU-stiff** | We address users in 2nd person ("Your trustworthy compliance checker…"). Dates are `DD/MM/YYYY`. Tone is "Stripe docs", not "government portal". |

---

## 3. Voice & tone

### Sentence case, always

- Buttons: `Start a new test` — not `Start A New Test`, not `START A NEW TEST`.
- Section headers carry a trailing colon: `Apps:`, `Test results:`, `Find credentials:`.
- Never SHOUTY CASE outside of eyebrow labels (which are uppercase and tracked
  +14% by typography rule, not by content).

### Imperatives for CTAs

`Start a new test` · `Explore Marketplace` · `Test interop and conformance` ·
`See pipelines` · `See history` · `See all ↗`

The "See all ↗" link with an arrow-up-right glyph is the canonical "more of
this elsewhere" pattern.

### Domain vocabulary is non-negotiable

Keep these terms **exact**, never paraphrase:

> credential issuer · verifier · wallet · conformance · interoperability ·
> OpenID4VC · OID4VCI · OpenID4VP · EUDI · EUDIW · mDoc · SD-JWT VC · JWT ·
> ES256 · jwk · cose_key · Draft 13 · Temporal · trust list · EUDI ARF

### Numbers, dates, formatting

| Type | Format | Example |
|---|---|---|
| Percentage | `N% compliant` | `80% compliant` |
| Run counts | `N over M tests passed` | `20 over 30 tests passed` |
| Date | `DD/MM/YYYY` | `24/04/2026` |
| Date + time | `DD MMM YYYY, HH:mm` (24h) | `20 May 2026, 14:32` |
| Identifier | monospace, all-caps | `OID4VCI · DRAFT 13` |
| Version | semver, monospace | `v2.4.1` |

### Emoji policy

**Never** in the product UI. Acceptable only in a GitHub README for navigation
purposes (📋, 🛠️). Empty and error states use illustrations, not emoji.

---

## 4. Logo

### Lockups

The design system names its lockups `credimi_logo.svg` (wordmark),
`credimi_logo_white.svg` and `credimi_logo_mark.svg`. **This template uses
different filenames for the same four roles** — the mapping below is the one to
follow in a derived project. The artwork is the same: the design system's
`credimi_logo_mark.svg` and `brand/logos/credimi_logo.svg` carry identical
viewBox, path data and gradient node ids.

| File in `brand/logos/` | Geometry | Use case |
|---|---|---|
| `credimi_logo-transp.svg` | 941 × 196 | **Wordmark** — icon plus the word "CREDIMI", dark text. Light backgrounds. Design-system equivalent: `credimi_logo.svg`. |
| `credimi_logo-transp_white.svg` | 941 × 196 | **Wordmark, white**. Indigo / dark backgrounds, footer, cover slides. Design-system equivalent: `credimi_logo_white.svg`. |
| `credimi_logo.svg` | 248 × 248 | **Mark / symbol**, dark. Square use: favicon, social avatar, app icon, inline banner glyph. Design-system equivalent: `credimi_logo_mark.svg`. |
| `credimi_logo_negative.svg` | 248 × 248 | **Mark / symbol**, negative. Dark backgrounds. |

The four are not interchangeable. Use the mark on light backgrounds and the
negative mark on dark ones; use the wordmark whenever the brand name has to be
legible.

### Minimum size

- **Wordmark**: 22px tall in product UI (topbar), 28px in marketing headers.
- **Mark**: 32px square minimum. Below that, keep the vector at @1x — don't
  rasterize. The one sanctioned exception is the 16px inline mark in the
  Credimi Extras banner ([§13](#13-credimi-extras-cross-promotional-banner)).

### Clear space

Reserve clear space equal to the height of the lowercase "c" on all four sides.
Don't place the logo against busy imagery; if you must, use the white wordmark
on a dark scrim.

### Don't

- Don't recolor any lockup.
- Don't recreate the gradient — always use the SVG. The gradient stops are
  tuned and shouldn't be paraphrased in code.
- Don't outline, drop-shadow, emboss, or apply effects.
- Don't place the wordmark next to another wordmark without ≥24px gap.
- Don't use the logo as decorative texture or repeat it.

---

## 5. Color

Always reference the custom property, never inline a hex. Every token below is
declared in `brand/style.css` — 102 of them, with no undefined `var()`
reference anywhere in the file.

### Primary — deep indigo

```css
--brand-primary:      #220E7E;   /* rgb(34,14,126) — Figma button fill */
--brand-primary-700:  #1A0A66;   /* hover */
--brand-primary-600:  #150753;   /* active */
--brand-accent:       #3D1FC4;   /* wordmark gradient, link accent */
--brand-accent-vivid: #9747FF;   /* dashed callout border */
```

Deep indigo carries everything important: primary CTAs, the footer slab,
indigo-on-light section accents, the gradient origin in the wordmark. It's the
only color allowed to dominate a layout (e.g. an entire footer band, a hero
slab). `--brand-accent` is reserved for the wordmark gradient and link accents.

`--brand-primary` was the same color on both sides of the merge — expressed as
`oklch(0.2955 0.1659 277.31)` in the old stylesheet and `#220E7E` in the design
system. The hex form won, for consistency with the rest of the palette.

### Secondary — lavender

```css
--brand-secondary:        #EEEAFE;   /* page wash + input bg */
--brand-secondary-mid:    #E2DCF8;   /* ownership row stripe */
--brand-secondary-strong: #D8CFFF;   /* sidebar accent, badge wash */
--brand-secondary-deep:   #CFC7EB;   /* secondary button fill */
```

Lavender is the **page tint** behind content. White is reserved for cards,
popovers, inputs. _Never_ put content directly on a pure-white page background
— always use the lavender wash + white cards combo.

### Neutrals

```css
--bg:           #FFFFFF;
--bg-muted:     #F6F6F6;   /* code/logo placeholder bg */
--bg-off-white: #FAFAFA;   /* text on indigo */
--fg:           #2F294B;   /* body + heading ink */
--fg-muted:     #9A97B5;   /* secondary text, rules */
--fg-subtle:    #606083;   /* caption text */
--border:       #E4E4E7;   /* input/card hairline */
--border-strong:#9A97B5;   /* table cell divider */
--fg-on-primary:#FAFAFA;
--card:         #FFFFFF;
--popover:      #FFFFFF;
```

### Semantic / status

Status chips have **exact, named colors**. Don't invent new statuses — propose
extensions upstream if you need them.

| Token | Value | Used for |
|---|---|---|
| `--success` / `--success-bg` / `--success-border` | `#058A57` / `#E5F4EC` / `#096D46` | Verifier · compliant · pass · "Stable" score band |
| `--warning` / `--warning-bg` | `#E9B93B` / `#FDF3D5` | Issuer · flaky · 60–79% score band |
| `--destructive` / `--destructive-bg` | `#EF4343` / `#FDE7E7` | Errors · destructive actions · <30% score band |
| `--wallet` / `--wallet-bg` | `#682596` / lavender wash | Wallet chip |
| `--credential` / `--credential-bg` | `#A04D0F` / `#FFE9D6` | Credential chip · 30–59% band |
| `--info` | `var(--brand-primary)` | Conformance · neutral info chip |

### Score bands (scoreboard / pipelines)

| Range | Label | Color band |
|---|---|---|
| ≥ 80% | **Stable** — safe to integrate against | green |
| 60–79% | **Flaky** — works most of the time, expect retries | amber |
| 30–59% | **Failing** — regressions in flight | orange |
| < 30% | **Broken** — see the detail page | red |
| no data | **—** | grey |

`style.css` carries these as `--score-stable`, `--score-flaky`,
`--score-failing`, `--score-broken`, each aliased to its semantic color so a
band and its chip cannot drift apart.

### Gradients

**Only** the wordmark and the mark use a gradient (indigo → blue → purple,
locked in the SVG). Everything else is solid color. If you find yourself
reaching for a gradient on a card, button, or background — stop. Use solid
lavender or solid indigo.

---

## 6. Typography

### Family

**Inter** is the only sans family, at weights 400 / 500 / 600 / 700 / 800 / 900.

**Source Code Pro** for monospace — used in the code-editor frame, test-ID
rows, and inline identifiers, at weights 400 / 500 / 700.

Both are **self-hosted**, vendored as variable TTFs in
[`brand/fonts/`](brand/fonts/) under SIL OFL 1.1. The design system loads them
from Google Fonts; a Credimi Extra must not, because
`HITL/01-harmonize-credimi-extras.md` forbids introducing third-party font
tracking. `brand/style.css` declares both with a relative `url()`, so keep
`fonts/` a sibling of `style.css` in the runtime copy.

Reach for the family through its token — `var(--font-sans)`,
`var(--font-display)`, `var(--font-mono)` — never a literal family name. The
merged stylesheet routes every rule through those three tokens, so a family
swap is a one-line change instead of a hunt through 14 hardcoded declarations.

> The stylesheet used to ship **Manrope** and **JetBrains Mono**. Both were
> dropped in the merge ([§16](#16-merge-record)); no file references them and
> their TTFs are no longer vendored.

### Scale

| Token | Size / line-height | Weight | Tracking | Used for |
|---|---|---|---|---|
| `--fs-display` | 48 / 48 | 700 | -0.012em | Page title on hero |
| `h1` / `--fs-4xl` | 46 / 50 | 700 | -0.012em | Marketing H1 |
| `h2` / `--fs-3xl` | 30 / 36 | 700 | -0.007em | Section headers, newsletter title |
| `h3` / `--fs-2xl` | 24 / 32 | 700 | -0.006em | Subsection / card titles |
| `h4` / `--fs-xl` | 20 / 28 | 700 | -0.005em | Card titles, lead body |
| `h5` / `--fs-lg` | 18 / 28 | 700 | 0 | "large" label, link card title |
| `--fs-md` | 16 / 28 | 400 | 0 | Body (paragraphs) |
| `--fs-base` | 14 / 20 | 400/500 | 0 | Body small, button label, input value |
| `--fs-xs` | 12 / 17 | 500 | +0.14em | Eyebrows, uppercase labels |

Line heights ship as paired `--lh-*` tokens. The merge took the design
system's scale wholesale, so the four steps above 18px are 2–6px smaller than
the stylesheet's previous values ([§16](#16-merge-record)).

### Display weights

Headings are **700** with negative tracking that scales with size (~-0.012em at
display down to -0.005em at h4). Don't drop below 500 for any title. Italic is
not used in product UI.

### Eyebrow pattern

```html
<p class="eyebrow">YOUR WORKSPACE</p>
<h1>Hi, Andrea1234test</h1>
```

- 12px, weight 500, letter-spacing 0.14em, uppercase.
- `--fg-muted` on lavender, `--brand-secondary-strong` on indigo.
- Always paired with a heading directly below.

### Numbers in display contexts

Monospace (`var(--font-mono)`) for any number that's an **identifier** (run counts, versions, IDs,
timestamps, test names like
`sd_jwt_vc:did:request_uri_unsigned:direct_post`). Sans for any number that's a
**measure** (percent, totals, durations).

```
312/412 runs       ← monospace (counts as identifier)
80% compliant      ← sans, weight 500 (measure)
v2.4.1             ← monospace
20/05/2026         ← monospace
1m 52s             ← sans
```

---

## 7. Spacing, radii, elevation

### Spacing scale

```css
--space-1: 4px;   --space-2: 8px;   --space-3: 12px;
--space-4: 16px;  --space-5: 20px;  --space-6: 24px;
--space-8: 32px;  --space-10: 40px; --space-12: 48px;
--space-16: 64px; --space-20: 80px;
--space-14: 56px;
```

Use the scale. Don't pick `15px` because it "looks right". Common multiples in
product UI:

- Card internal padding: `16px` or `20px` (`--space-4` / `--space-5`)
- Section gap: `24px` (`--space-6`)
- Page vertical rhythm: `32px` (`--space-8`)
- Hero padding: `40–56px`

Spacing was the one category where the two merged sources already agreed
completely, step for step. Treat it as the spine.

### Corner radii

```css
--radius-xs:    4px    /* badges, status chips */
--radius-sm:    5px    /* callout containers */
--radius:       6px    /* CANONICAL — buttons, inputs, cards */
--radius-md:    8px    /* alerts, avatar squares */
--radius-lg:   10px    /* hero cards (rare) */
--radius-xl:   12px    /* large feature blocks (rare) */
--radius-pill: 999px   /* pills, segmented controls */
```

**6px is the canonical radius** for buttons, inputs and cards — reach for
`--radius`. Chips and badges use `--radius-xs`, alerts `--radius-md`.

> The two merged sources used the same radius names for different values
> (`--radius-md` meant 6px in one and 8px in the other). The merge resolved it
> by adopting the design system's names and rewriting every call site, so
> `--radius` is now the single alias for the 6px button radius and the collision
> cannot come back. [§16](#16-merge-record) records the two pixel deltas that
> resulted.

### Shadow / elevation

Credimi is **almost flat**. Use shadows sparingly — most surfaces have none,
relying on the 1px hairline border instead.

```css
--shadow-sm:  0 1px 2px 0 rgba(12,12,13,.05)                                    /* focus rings, input hover */
--shadow:     0 1px 3px 0 rgba(12,12,13,.08), 0 1px 2px -1px rgba(12,12,13,.06) /* popovers, tooltips */
--shadow-md:  0 4px 6px -1px rgba(0,0,0,.08), 0 2px 4px -2px rgba(0,0,0,.06)    /* dropdowns, menus */
--shadow-lg:  0 10px 15px -3px rgba(0,0,0,.10), 0 4px 6px -4px rgba(0,0,0,.10)  /* modals, toasts */
```

Two-layer with negative spread, from the design system. The pre-merge
stylesheet used flat single-layer shadows; same intent, softer construction.

If you're using anything above `--shadow-md`, ask yourself if the element
really needs to "lift" — usually it doesn't.

---

## 8. Layout & grid

### Container

- **Max content width**: 1280px (`--max-width`), centered.
- **Page side padding**: 24–32px on desktop, 16px on mobile.
- **Topbar**: sticky, white, 1px hairline bottom border, no shadow, 56px tall
  (`--topbar-height`).
- **Footer**: deep-indigo slab, full-bleed, with a `rgba(0,0,0,0.3)` overlay
  bottom strip reading "Proudly developed by ForkBomb BV". The only sanctioned
  use of translucency — the bottom banner strip in
  [§13](#13-credimi-extras-cross-promotional-banner) rides on this same fill.

### Page chrome pattern

```
┌─────────────────────────────────────────────┐
│  Credimi Extras banner (top strip)          │
├─────────────────────────────────────────────┤
│  topbar (sticky · white · 1px border)       │
├─────────────────────────────────────────────┤
│  hero / header band                         │
│  (lavender · diagonal-fold motif top-right) │
├─────────────────────────────────────────────┤
│  main content                               │
│  (lavender wash · max-width · white cards)  │
├─────────────────────────────────────────────┤
│  footer (deep indigo · forkbomb sub-bar     │
│          · Credimi Extras bottom strip)     │
└─────────────────────────────────────────────┘
```

### Section header pattern

The most-used pattern in the product. Memorize it.

```html
<div class="cd-section-header">
  <h2>Test results <span class="count">3</span>:</h2>
  <a class="cd-link">See all <span aria-hidden>↗</span></a>
</div>
```

- H2 title with trailing colon (always).
- Optional inline count chip in lavender-grey.
- 1px bottom border in `--border`.
- Optional "See all ↗" link on the right, underlined, indigo, with the
  arrow-up-right glyph.

### Card grid density

| Surface | Grid | Card padding |
|---|---|---|
| Dashboard | 2 columns | 16px |
| Marketplace | 3 columns | 16px |
| Hub / catalogue | 4 columns | 14px |
| Scoreboard list | 1 column (full-width cards) | 18px |

### Diagonal-fold motif

A faint criss-cross pattern (two thin diagonals, opacity 0.06–0.10) lives in the
**top-right of hero / page-header bands**. Echo it as a smaller watermark in the
top-right of feature cards if the page needs the visual continuity.

> Use it on **page headers and marketing surfaces**. Never as decoration in body
> content, never as a full-bleed texture. If it competes for legibility, kill it.

---

## 9. Iconography & illustration

### Icons

- **Lucide** is the only icon family.
- Stroke width `1.5px`, line style.
- Default size: 16–20px in product UI, 14–16px in dense tables.
- Color: inherit from text (`currentColor`). Don't fill, don't tint.
- Names in use across Credimi: `ArrowDown`, `ArrowUp`, `ArrowUpRight`,
  `LayoutDashboardIcon`, `BadgeCheck`, `ShieldCheck`, `ClockIcon`, `CogIcon`,
  `HandIcon`.

### Status chip icons

Use the Lucide filled variant only inside status chips (`BadgeCheck` inside
Verifier). Outside chips, prefer text labels over icon-only buttons.

### Illustrations

Two scenes are specified for **error / empty states**: `404-computer.svg`
(404 / not-found) and `maintenance.svg` (outage / maintenance).

> ⚠️ **Neither is currently available.** They do not ship in this template, and
> the copies in the design system project are broken: each is a `<rect>` filled
> by a pattern that references an `<image>` element carrying no data. Until
> working files exist, an empty state has to fall back to copy alone —
> a documented exception to the rule below, not a licence to invent artwork.

They're flat multi-color vectors. Don't generate new ones with AI. If you need a
new illustration, commission a vector artist and match the existing style (flat,
restrained palette, no gradients).

### Hero imagery

Hero photography exists in the design system (`assets/hero.png`) but is rare —
used behind the indigo header band, desaturated. It is not vendored here; pull
it from the design system if a surface actually needs it. Default to the diagonal-fold
motif on lavender; photography is an exception.

### Avatars

Default avatars in the Hub are **Auth0-style geometric identicons** — gradient
squares with abstract glyphs. Real org logos override the identicon when
available.

---

## 10. Motion

Credimi motion is **functional, not decorative**.

| Motion | Duration | Easing | Used for |
|---|---|---|---|
| Hover state | 150ms | `ease-out` | Buttons, links, cards |
| Focus ring | 200ms | `ease-out` | Inputs, focusable rows |
| Popover / dropdown | 200ms | `ease-out` | + 8px slide-up + fade |
| Toast | 220ms | `ease-out` | — |
| Page transition | none | — | We don't do page transitions |

### Forbidden

- Bounces, spring physics, parallax.
- Animations longer than 250ms in the product UI (slides and marketing get more
  rope).
- Auto-playing video, scroll-jacked animation, mouse-tracked effects.

### Loading

Plain ring spinners, indigo. No skeleton shimmer animations — skeletons are
static `--bg-muted` blocks.

---

## 11. Components

### Buttons

| Variant | Use case | Fill | Text |
|---|---|---|---|
| **Primary** | The page's main CTA. One per surface. | `--brand-primary` | `--fg-on-primary` |
| **Secondary** | Adjacent to a primary. Soft action. | `--brand-secondary-deep` | `--brand-primary` |
| **Outline** | Tertiary actions. | `--bg` + 1px `--border` | `--fg` |
| **Ghost** | Toolbar buttons, dense surfaces. | transparent | `--fg` |
| **Destructive** | Confirm-delete only. | `--destructive` | `--bg` |
| **Link** | Inline / "See all ↗". | transparent | `--brand-primary` + underline |

Sizes: `sm` (28px), `md` (40px default), `lg` (48px). All buttons use the 6px
canonical radius. Label is 500 / 14 / 20.

### Alerts

| Variant | Border | Text | Icon |
|---|---|---|---|
| **Success** | `#096D46` (`--success-border`) | `#096D46` | `check-check` |
| **Destructive** | `#EF4343` (`--destructive`) | `#EF4343` | `triangle-alert` |
| **Info** | `--brand-primary` | `--brand-primary` | `circle-info` |

Alerts are 1px-bordered, 8px-radius rectangles with a 60% white background
(`rgba(255,255,255,0.6)`), 17px padding, a 500/16 heading + 400/14 body, and an
18×18 Lucide icon in the top-left.

### Popovers / MegaMenu

White background, 6px radius, 1px `--border-strong`, `--shadow-md`. Internal
padding 16–24px. MegaMenu is a 600×358 grid of 4 link cards in a 2×2.

### Status chips

Pill shape (`--radius-pill`), 12×12 colored dot + 11px label, exact colors from
the semantic palette. Kinds: `verifier · wallet · issuer · credential ·
custom-check`. Nesting rules in [§14](#14-chips-and-badges).

### Cards

White background, 10px radius, 1px hairline border, **no shadow** by default.
Internal padding `16–20px`. Top row of a service card is always:

```
[avatar] [name] [badge]                    [actions →]
```

On hover: border darkens to `--border-strong`. No `transform` lift.

### Inputs

- 36px tall, 10px radius, 1px hairline border, white background.
- Focus: `border-color: var(--brand-primary)` + 3px indigo ring at 18% alpha.
- Placeholder copy uses sentence case + trailing colon:
  `Find applications, features and services:`

### Compliance pills

Score % + band label, color-banded per [§5](#5-color). Always paired with the
band label in the small `eyebrow` style next to the number.

---

## 12. Patterns

### Service / app card

Avatar → name → status chip → 1-line description → optional compliance pill.
Used in Marketplace, Dashboard "My apps", Hub.

### Test result row

```
Name              Last check       Pass ratio
DIDroom · OID4VCI 24/04/2026       20 over 30 tests passed   [80% compliant]
```

Always: name in sans-bold, dates in monospace, pass-ratio in sans + monospace
fraction, score pill on the right.

### Pipeline detail

Universal drill-down pattern. Top: the flow chain (wallet → credential → issuer
→ verifier). Body: step-by-step results grouped by stage (Issuance /
Presentation / Trust). Right column: recent runs + claimed specs. Bottom: a
colored **failure callout** when state is `failing`/`broken` that names the root
cause and offers an action.

### Empty / error states

Center-aligned illustration above a sentence-case headline + one CTA. Never
express an empty state with copy alone — pair it with the illustration.

### Cross-cutting "See all" pattern

Section header + `See all ↗` link on the right. Always underlined, indigo, with
the arrow-up-right glyph (Lucide `ArrowUpRight`).

---

## 13. Credimi Extras cross-promotional banner

Every derived application must carry the Credimi Extras banner on every HTML
page, as two strips of the same sentence.

The copy is fixed and identical in every application:

> This app is part of **Credimi Extras**. Automate all your EUDI testing with
> **Credimi**

The top strip sits immediately above the topbar, as the first element inside
the page body. It uses the `--brand-secondary` background and `--brand-primary`
text of the application's own palette, centred content, and an inline 16px
`credimi_logo.svg` (the mark) before the sentence. The trailing word "Credimi" is the link.

The bottom strip closes the existing footer, after any content already there,
on a translucent dark fill over the footer's own brand background rather than a
new colour. Its text is white at reduced opacity, and in place of the trailing
word it inlines the `credimi_logo-transp_white.svg` wordmark at about 16px
tall, with `alt="Credimi"`.

Both strips link to `https://credimi.io` in a new tab, with `rel="noopener"`.
Neither strip is sticky, dismissible, or animated, and neither is clickable as
a whole: only the trailing word or wordmark is an anchor, never the bar. The
sentence must read on one line at desktop width and wrap rather than truncate
at phone width, and the link must be keyboard reachable with a visible focus
state.

Take colours from the tokens in `brand/style.css` rather than hardcoded
values, and add the banner's rules to the application stylesheet that loads
after it. The banner is application chrome, not brand: it does not belong in
`brand/style.css`.

The sibling Credimi Extras repositories `credimi-capture-wallet`,
`eudi-conformance-atlas`, `eudi-trusted-list-publisher` and
`eudi-trust-inspector` carry reference implementations of both strips across
four different stacks.

---

## 14. Chips and badges

When a view shows a category badge next to a member of that category, only the
category gets a filled pill. The member's own label stays plain text, coloured
to match its category, with no background, border, or padding of its own. A
second nested pill compounds visual noise once several members share one
category, and it competes with the badge that actually carries the grouping.

Keep such colour mappings declarative in the stylesheet, one modifier class per
category, so the pill and the plain label cannot drift apart.

---

## 15. Do & Don't

### Do

- ✓ Use the lavender wash + white card combo.
- ✓ Keep cards hairline-bordered, shadow-less.
- ✓ Use Inter at 700 for display, 400–500 for body.
- ✓ Use `DD/MM/YYYY` for dates, monospace for IDs.
- ✓ Match status colors exactly to the semantic palette.
- ✓ Use the diagonal-fold motif sparingly, only in page headers.
- ✓ Show numbers unsoftened ("20 over 30 tests passed").
- ✓ Pair every eyebrow with a heading directly below.

### Don't

- ✗ Use gradients anywhere except the wordmark and the mark.
- ✗ Use emoji in product UI.
- ✗ Use SHOUTY CASE in titles or button labels.
- ✗ Use AI-generated illustrations.
- ✗ Use Roboto, Arial, or system-default fonts. (Inter IS the brand sans.)
- ✗ Use Manrope as the body font. It was a former substitution — Inter IS
  the brand sans.
- ✗ Use shadows on cards by default.
- ✗ Use rounded corners with a left-border accent color.
- ✗ Use icons inside buttons unless the icon is semantically required.
- ✗ Use exclamation marks anywhere in the product UI.
- ✗ Use the diagonal-fold pattern as body decoration.
- ✗ Recolor or modify the logo.
- ✗ Modify, regenerate, optimize, or convert anything in `brand/logos/`.
- ✗ Hardcode a family name, hex, or px value that already has a token.

---

## 16. Merge record

`brand/style.css` is the merge of two stylesheets that used to disagree:

- **`HITL/style.css`** — the canonical application stylesheet (its own header
  read "Credimi Design Tokens — EUDI Conformance Atlas"), frozen by SHA-256 and
  forbidden from modification.
- **`colors_and_type.css`** — the design system's Figma-derived token file.

They conflicted in 18 tokens outright, 8 more near-misses, both font families,
and every radius name. Holding them as two layers meant every derived app
re-deriving the same override by hand. They are now one file.

### What the merge changed

| Area | Before | After |
|---|---|---|
| Sans family | Manrope, hardcoded in 5 rules | Inter, via `var(--font-sans)` |
| Mono family | JetBrains Mono, hardcoded in 9 rules | Source Code Pro, via `var(--font-mono)` |
| Font hosting | `../fonts/*.ttf`, files absent from the repo | vendored in `brand/fonts/`, OFL 1.1 |
| Color syntax | `oklch()` for most tokens | design-system hex |
| `--fg` | near-black navy | `#2F294B` violet ink |
| `--radius-md` call sites (8) | 6px | rewritten to `--radius`, still 6px |
| `--radius-sm` call site (1) | 2px | rewritten to `--radius-xs`, **4px** |
| `--radius-xl` | 14px | **12px** |
| Type steps above 18px | 48 / 36 / 28 / 22 | 46 / 30 / 24 / 20 |
| `h1`–`h2` weight | 800 | 700, with design-system tracking |
| Shadows | flat single-layer | two-layer, negative spread |
| `#e5e7eb`, `#111827`, `#6b7280` | hardcoded, in neither palette | `--border`, `--fg`, `--fg-subtle` |
| bare `color: white` (6 rules) | literal | `var(--fg-on-primary)` |

Only three visible deltas survive: callout corners gain 2px, `--radius-xl`
loses 2px, and headings above 18px are 2–6px smaller at weight 700 instead of
800. Everything else either matched already or was a syntax change.

### What the merge added

The ~30 tokens the old stylesheet never defined: `--brand-accent`,
`--brand-accent-vivid`, `--brand-secondary-mid`, `--brand-secondary-deep`,
`--fg-subtle`, `--fg-on-primary`, `--fg-link`, `--card`, `--popover`,
`--bg-tint`, `--border-soft`, `--input`, `--ring`, `--success-border`,
`--warning-fg`, `--wallet-border`, `--credential-border`, `--verifier`,
`--verifier-bg`, `--radius-xs`, `--radius`, `--space-14`, `--font-sans`,
`--font-display`, `--font-mono`, `--fs-display`, and the ten `--lh-*` line
heights.

Plus the design system's semantic type helpers: `.h-display`, `.lead`,
`.p-base`, `.p-muted`, `.small`, `.label`, `.eyebrow`, `.inline-code`,
`.surface-tint`, `.surface-card`.

### What the merge kept

App-scoped tokens that exist only on the upstream side and have no
design-system equivalent: `--score-stable` / `-flaky` / `-failing` / `-broken`,
`--info-bg`, `--max-width`, `--topbar-height`, `--role-sidebar-width`, and the
six `--badge-protocol` / `-etsi` / `-iso` tokens.

Also kept: the whole application layer the upstream file carried — role
sidebar, document tree, donut charts, test-coverage tables, bottom sheets.
Those belong to one Credimi Extra, not to the brand, and splitting them out is
a separate task.

### Governance

`HITL/01-harmonize-credimi-extras.md` names `HITL/style.css` as the canonical
design input and requires byte-equality tests against it. That brief is a
frozen human document; this merge contradicts it and the contradiction is
logged in [`directives/HITL.md`](directives/HITL.md) as `hitl-0003` for human
resolution.

The logo SVGs kept their bytes through the move, so their SHA-256 pins in
[§1](#1-canonical-assets) still verify.

### Still required

Run the undefined-custom-property lint that `AGENTS.md` requires. It passes on
`brand/style.css` today — 102 tokens defined, zero undefined `var()` references
— and it is what keeps a future edit from silently dropping a declaration.

---

## Versioning & contribution

- **The design system is the spec.** When it conflicts with a one-off
  implementation, the design system wins. When it conflicts with this file,
  fix this file — and when it conflicts with `brand/style.css`, fix the
  stylesheet, because that is now the only place tokens live.
- Propose changes via PR. Anyone modifying the palette, type scale, or component
  primitives needs sign-off from Design + Engineering.
- When a new component graduates from prototype → production, add it to
  [§11](#11-components) and ship a worked example.
- Tokens are the source of truth. Never inline a hex or a px value that already
  has a token.

---

_Maintained by Forkbomb BV · Merged from the Credimi Design System, last synced 05/09/2026_
