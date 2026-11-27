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
application's own stylesheet after it. The runtime copy tracks the
`credimi-extras-template` commit `fd5d283` (26/11/2026).

References in this document to `brand/`, `directives/HITL.md`, `HITL/…` and
the undefined-custom-property lint are inherited from the upstream Credimi
Extras template; this repository does not carry those HITL files.

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
17. [Page layout update](#17-page-layout-update)
18. [Typography update](#18-typography-update)

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
| Identifier | all-caps, Inter with `.data` | `OID4VCI · DRAFT 13` |
| Version | semver, Inter with `.data` | `v2.4.1` |

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
| `credimi_logo.svg` | 248 × 248 | **Mark / symbol**, dark. Topbar, favicon, social avatar, app icon, inline banner glyph. Design-system equivalent: `credimi_logo_mark.svg`. |
| `credimi_logo_negative.svg` | 248 × 248 | **Mark / symbol**, negative. Dark backgrounds. |

The four are not interchangeable. Use the mark on light backgrounds, including the product topbar, and the negative mark on dark ones. Use the wordmark where the brand name must be legible outside the topbar.

### Minimum size

- **Wordmark**: 22px tall in product UI outside the topbar, 28px in marketing headers.
- **Mark**: 32px square minimum, including in the topbar. Below that, keep the
  vector at @1x — don't rasterize. The one sanctioned exception is the 16px
  inline mark in the Credimi Extras banner
  ([§13](#13-credimi-extras-cross-promotional-banner)).

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
declared in `brand/style.css` — 104 of them, with no undefined `var()`
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
--bg-muted:     #FAF8FC;   /* code/logo placeholder bg — a faint lavender */
--bg-off-white: #FAFAFA;   /* text on indigo */
--fg:           #2F294B;   /* body + heading ink */
--fg-muted:     #9A97B5;   /* secondary text, rules */
--fg-subtle:    #606083;   /* caption text */
--border:       #E4E4E7;   /* input/card hairline */
--border-strong:#9A97B5;   /* rules, outlines, hover borders */
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

**Source Code Pro** for monospace, **only for code**: `code`, `pre`,
`.inline-code`, `.mono` / `.font-mono`, and the [deeplink](#qr-code-deeplink-and-copy-button).
Weights 400 / 500 / 700. Identifiers, test names, URLs, dates and versions are
not code; they are Inter (see
[Numbers in display contexts](#numbers-in-display-contexts)).

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

`--font-data-features` turns on three Inter OpenType features for text that is
data rather than prose: `tnum` (tabular digits, so columns align), `zero`
(slashed zero, so `0` is not `O`), and `ss02` (disambiguation, so `I`, `l` and
`1` differ). Apply it with the `.data` utility class, or with
`font-feature-settings: var(--font-data-features)` in a component rule.

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
- Never above a hero or section title: the section intro carries the title on
  its own ([§8](#8-layout--grid)).

### Numbers in display contexts

Every number is Inter. A number that's an **identifier** (run counts, versions,
IDs, timestamps, dates, test names like
`sd_jwt_vc:did:request_uri_unsigned:direct_post`) takes `.data`. A number
that's a **measure** (percent, totals, durations) is plain sans.

```
312/412 runs       ← .data (counts as identifier)
80% compliant      ← sans, weight 500 (measure)
v2.4.1             ← .data
20/05/2026         ← .data
1m 52s             ← sans
```

### JSON and code output

Render JSON and source output as a focusable Shiki Catppuccin Frappé `<pre>`,
using Credimi's class contract:

```html
<pre class="shiki catppuccin-frappe p-4 w-full min-h-0 grow h-full overflow-auto code-display-scroller scrollbar-on-dark text-sm transition-all max-h-[350px]" tabindex="0"><code>…</code></pre>
```

`code-display-scroller` supplies the utility-class layout semantics in
`brand/style.css`, so derived projects do not need Tailwind. It grows within a
flex region, fills its available height, scrolls in both directions, and caps
its visible height at 350px. Shiki provides syntax spans and the Catppuccin
Frappé palette; the shared stylesheet provides the matching surface and dark
scrollbar. Keep failures in alerts, not in the code output.

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
--radius:       6px    /* CANONICAL — inputs, cards */
--radius-md:    8px    /* alerts, avatar squares */
--radius-lg:   10px    /* buttons, hero cards */
--radius-xl:   12px    /* large feature blocks (rare) */
--radius-pill: 999px   /* pills */
```

**6px is the canonical radius** for inputs and cards — reach for `--radius`.
Buttons use `--radius-lg` (10px), see [§11](#11-components). Chips and badges
use `--radius-xs`, alerts `--radius-md`.

> The two merged sources used the same radius names for different values
> (`--radius-md` meant 6px in one and 8px in the other). The merge resolved it
> by adopting the design system's names and rewriting every call site, so
> `--radius` is now the single alias for the 6px radius and the collision
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

- **Max content width**: 1440px (`--max-width`), centered.
- **Page side padding**: 24–32px on desktop, 16px on mobile.
- **Topbar**: sticky, white, 1px hairline bottom border, no shadow, 56px tall
  (`--topbar-height`).
- **Footer**: deep-indigo slab, full-bleed, with two distinct `rgba(0,0,0,0.3)`
  bottom sub-bars. The first reads “Proudly developed by
  [ForkBomb BV](https://forkbomb.solutions/)”; the company name is the only
  link, opens in a new tab, and uses `rel="noopener"`. The second is the
  Credimi Extras banner in [§13](#13-credimi-extras-cross-promotional-banner).
  These are the only sanctioned uses of translucency.

### Topbar identity

Pair the 32px `credimi_logo.svg` mark with the project title. Do not use either
wordmark in the topbar. The mark's `alt` text must be `Credimi`; the visible
project title distinguishes the application.

```html
<a class="topbar-brand" href="/">
  <img class="topbar-logo" src="/logos/credimi_logo.svg" alt="Credimi">
  <span class="topbar-project-title">Project title</span>
</a>
```

### Page chrome pattern

```
┌─────────────────────────────────────────────┐
│  Credimi Extras banner (top strip)          │
├─────────────────────────────────────────────┤
│  topbar (sticky · white · 1px border)       │
├─────────────────────────────────────────────┤
│  hero band                                  │
│  (deep indigo · white title + description   │
│   · fold motif over the right part)         │
├─────────────────────────────────────────────┤
│  page sections, 96px apart                  │
│  (lavender wash, alternating with white;    │
│   each opens with a section intro)          │
├─────────────────────────────────────────────┤
│  footer (deep indigo · forkbomb sub-bar     │
│          · Credimi Extras bottom strip)     │
└─────────────────────────────────────────────┘
```

Every page opens with the hero band: the page's title at hero size in white,
with a short white description, on `--brand-primary`. The page's content follows
as a run of `.page-section`s, 96px top and bottom (64px on mobile), on the
lavender wash; `.page-section-white` sets a section apart on white. Forms, QR
codes, and their controls sit directly on the section, not in a card; a card is
for a link to a document ([§11](#11-components)) or a panel whose border and
fill show live state.

```html
<section class="hero-band" aria-labelledby="page-title">
  <div class="hero-inner">
    <header class="section-intro">
      <div class="section-intro-heading">
        <h1 class="section-intro-title" id="page-title">Wallet metadata capture</h1>
      </div>
      <div class="section-intro-description"><p>What the page is for.</p></div>
    </header>
  </div>
</section>
<section class="page-section" aria-labelledby="issue-title">
  <div class="container">…</div>
</section>
```

### Section intro pattern

The most-used pattern in the product. Memorize it.

```html
<header class="section-intro">
  <div class="section-intro-heading">
    <h2 class="section-intro-title" id="issue-title">Issue a credential</h2>
    <span class="count-chip">3</span>
  </div>
  <div class="section-intro-description">
    <p>One or two sentences on what the section offers.</p>
  </div>
</header>
```

- The title in `--brand-primary`, h2 size, **no trailing colon**.
- A 1px rule in `--border-strong` under the title row.
- An optional count chip, or a "See all ↗" link, at the end of the title row.
- One or two description paragraphs in `--fg-muted`, at most 720px wide.
- Inside the hero band the same markup is the page title: no rule, white, at
  hero size.
- Groups inside a section are introduced by a `.subsection-heading` (20px, 700,
  `--fg`).

A card's own title row is a `.panel-head`: a sub-heading, an optional status
chip at the end, and a 1px `--border` hairline under it, again with no colon.

The colon heading (`.section-header`) and the lavender `.hero` remain in
`brand/style.css` only so applications built on them keep their look until they
migrate ([§17](#17-page-layout-update)).

### Card grid density

| Surface | Grid | Card padding |
|---|---|---|
| Dashboard | 2 columns | 16px |
| Marketplace | 3 columns | 16px |
| Hub / catalogue | 4 columns | 14px |
| Link cards | 3 columns (1 on mobile) | 20px |

### Fold motif

Two translucent white triangles fold the right part of the hero band: the
upper one at 6% white, the lower one at 4%. `.hero-band` draws them; nothing
else does.

> Use it on **the hero band only**. Never as decoration in body content, never
> as a full-bleed texture. If it competes for legibility, kill it.

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

Every component honours the `hidden` attribute: `brand/style.css` sets
`[hidden] { display: none !important; }`, so a component's own `display` never
reveals an element the page hid.

### Buttons

| Variant | Use case | Fill | Text |
|---|---|---|---|
| **Primary** | The page's main CTA. One per surface. | `--brand-primary` | `--fg-on-primary` |
| **Secondary** | Adjacent to a primary. Soft action. | `--brand-secondary-deep` | `--brand-primary` |
| **Outline** | Tertiary actions. | `--bg` + 1px `--border` | `--fg` |
| **Ghost** | Toolbar buttons, dense surfaces. | transparent | `--fg` |
| **Destructive** | Confirm-delete only. | `--destructive` | `--bg` |
| **Link** | Inline / "See all ↗". | transparent | `--brand-primary` + underline |

Sizes: `sm` (28px), `md` (36px), `lg` (44px). Use `lg` for a page's or a form's
main actions, `md` inside cards and panels, `sm` in table rows and toolbars. All
buttons use `--radius-lg` (10px). Labels are 600, at 13px (`sm` 12px, `lg`
16px). These are the values `brand/style.css` renders; the Credimi Design System
project still lists 40 / 48px, a 6px radius and a 500 / 14 label, and needs the
same update so the two agree again.

### Alerts

| Variant | Border | Text | Icon |
|---|---|---|---|
| **Success** | `#096D46` (`--success-border`) | `#096D46` | `check-check` |
| **Warning** | `--warning-fg` | `--warning-fg` | `triangle-alert` |
| **Destructive** | `#EF4343` (`--destructive`) | `#EF4343` | `triangle-alert` |
| **Info** | `--brand-primary` | `--brand-primary` | `circle-info` |

Alerts are 1px-bordered, 8px-radius rectangles with a 60% white background
(`rgba(255,255,255,0.6)`), 17px padding, a 500/16 heading + 400/14 body, and an
18×18 Lucide icon in the top-left. An action, usually a ghost "Dismiss" button,
closes the row.

Inline, an alert sits at the top of the region it concerns. As feedback to an
action it floats (`.alert-floating`): solid white with `--shadow-lg` in the
bottom-right corner, until the user dismisses it or starts the next action.
Failures and hints go to an alert, never to an output or log box in the page. A
successful action shows its result where it happened, and needs an alert only
when it has no visible result.

```html
<div class="alert alert-destructive alert-floating" role="alert">
  <svg class="alert-icon" viewBox="0 0 24 24" aria-hidden="true">…triangle-alert…</svg>
  <div>
    <p class="alert-title">The action failed</p>
    <p class="alert-body">The list has 3 free entries left.</p>
  </div>
  <button class="btn btn-sm btn-ghost" type="button">Dismiss</button>
</div>
```

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

The one exception is a **link card**, a whole card that opens a document:
see below.

### Metric cards

A row of key figures, such as a list's entries and how many are revoked: each
is a card (above) holding a value in display type (700, `--fs-3xl`,
`--brand-primary`) above its label in the [eyebrow](#eyebrow-pattern) style.
Four to a row, two on mobile. Values are measures, so they are plain sans (see
[Numbers in display contexts](#numbers-in-display-contexts)); a value that is an
identifier, such as a version, takes `.data`.

```html
<div class="metric-grid">
  <div class="card">
    <strong class="metric-value">10000</strong>
    <span class="eyebrow">Entries</span>
  </div>
  …
</div>
```

### Tables

Data tables follow the Scoreboard (`credimi.io/scoreboard`); `.test-table`
inside a `.test-table-wrap` renders them.

- A white surface (`--bg`, 6px `--radius`) on the lavender wash, with no border
  and no shadow.
- A 40px header band in `--brand-secondary-strong`. Its labels are uppercase
  labels ([§6](#6-typography)): `--fs-xs`, weight 500, +0.14em, in
  `--brand-primary`.
- Rows divided by a 1px `--border` hairline, cells top-aligned with 12px of
  padding; a hovered row turns `--bg-muted`.
- The first cell names the row and may add a second line with its status chip
  and counts, in the order of a test result row ([§12](#12-patterns)).

```html
<div class="test-table-wrap">
  <table class="test-table">
    <thead><tr><th>Pipeline</th><th>Last run</th></tr></thead>
    <tbody>…</tbody>
  </table>
</div>
```

### Scrollbars

Every scrollable surface uses Credimi's scrollbar, as credimi.io does: a 10px
pill in `--brand-primary`, inset 2px on a transparent track, that lightens to
85% indigo under the pointer. `brand/style.css` sets it for the whole page,
through the `::-webkit-scrollbar` pseudo-elements in Blink and WebKit and
`scrollbar-color` in Firefox. On an indigo surface, add `.scrollbar-on-dark`
for a translucent white thumb.

### Inputs

Two sizes, by where the input lives:

- **Form fields** (`.form-field`, see [Form row](#form-row)): every control
  (text, number, date, select, textarea) is 44px tall, `--radius` (6px), 1px
  `--border-strong`, white, with a 600/14 value; a textarea starts at 96px and
  resizes vertically only. Focus: a 2px `--ring` outline, 2px offset.
- **Search and toolbar inputs**: 36px tall, 10px radius, 1px hairline border,
  white background. Focus: `border-color: var(--brand-primary)` + 3px indigo
  ring at 18% alpha.
- A file picker is a button: a `<label class="btn btn-outline btn-lg btn-file">`
  wrapping the native file input, which stays focusable and out of sight; the
  button shows the focus ring.
- Placeholder copy uses sentence case + trailing colon:
  `Find applications, features and services:`

### Compliance pills

Score % + band label, color-banded per [§5](#5-color). Always paired with the
band label in the small `eyebrow` style next to the number.

### Link cards

A whole card that opens a document, usually in a new tab: its title, its URL in
small muted Inter with the data features, and the arrow-up-right glyph in the
top-right corner. Its border is
`--brand-primary`; on hover it lifts 4px with `--shadow-md`, the only card that
moves, because the whole card is the link. A card whose target is not a safe
URL is rendered as an `<article>`: hairline border, no arrow, no lift.

```html
<nav class="link-cards" aria-label="Issuer metadata">
  <a class="link-card" href="https://…/.well-known/openid-credential-issuer"
     target="_blank" rel="noreferrer">
    <h3>OpenID4VCI credential issuer metadata</h3>
    <p class="link-card-url">https://…/.well-known/openid-credential-issuer</p>
  </a>
</nav>
```

### Tabs

Alternate views of one object, such as a list's entries, its token and its
decoded content, one visible at a time. Not for moving between pages (that is
the topbar) or for the steps of a flow. Labels are sentence case, one to three
words; a count may follow as a chip. The row sits on a hairline; labels are
500/13 `--fg-muted`, and the selected tab is `--brand-primary` with a 2px
underline.

Tabs follow the WAI-ARIA tabs pattern: `role="tablist"` around `role="tab"`
buttons carrying `aria-selected` and `aria-controls`, only the selected tab in
the tab order, Left and Right arrows moving between tabs, and each
`role="tabpanel"` hidden while its tab is not selected.

```html
<div class="tabs" role="tablist" aria-label="List views">
  <button class="tab-btn" type="button" role="tab" aria-selected="true" aria-controls="entries-panel">Entries</button>
  <button class="tab-btn" type="button" role="tab" aria-selected="false" aria-controls="token-panel" tabindex="-1">Token</button>
</div>
<div role="tabpanel" id="entries-panel">…</div>
<div role="tabpanel" id="token-panel" hidden>…</div>
```

### Disclosure

A collapsible panel, such as a form's advanced settings, closed by default. The
summary is one short word or two ("Advanced") and ends in a chevron in `--fg`
that points down when closed and up when open. Its content sits in
`.disclosure-body`, 16px from the panel's edge.

```html
<details class="disclosure">
  <summary>Advanced</summary>
  <div class="disclosure-body">…</div>
</details>
```

### Form row

A form's controls on one row with the primary button last, on the right. Each
field carries its label above it as a `.subsection-heading`, so the row aligns
on the bottom. The button names the action in one word where it can ("Start",
"Issue", "Verify"). A fixed-width field takes `.form-field-sm` (140px) or
`.form-field-md` (200px); one `.form-field-grow` takes the rest. On mobile every
control takes the full width.

```html
<div class="form-row">
  <label class="form-field form-field-grow">
    <span class="subsection-heading">Credential</span>
    <select>…</select>
  </label>
  <button class="btn btn-primary btn-lg" type="submit">Issue</button>
</div>
```

### Segmented control

One choice out of two to four, such as a flow, painted as a rounded rectangle
(`--radius`, its segments `--radius-xs`). The checked segment is
`--brand-primary` with `--fg-on-primary` text. It is built from native radio
inputs, so it keeps keyboard use and form state.

```html
<div class="form-field">
  <span class="subsection-heading" id="flow-label">Flow</span>
  <div class="segmented" role="radiogroup" aria-labelledby="flow-label">
    <label><input type="radio" name="flow" value="issue" checked><span>Issue</span></label>
    <label><input type="radio" name="flow" value="present"><span>Present</span></label>
  </div>
</div>
```

### Switch and featured option

A switch is an on/off checkbox painted as a track, filled with
`--brand-primary` when on. A **featured option** sets one switch apart: first in
its panel, alone, on a white card with a 1px `--brand-primary` border, 4px on
the left, and its label in `--brand-primary`. Use it for the single option that
matters most, and at most once per panel. A link in its hint may point to the
related service.

```html
<div class="featured-option">
  <label class="switch">
    <input type="checkbox" role="switch" checked>
    <span class="switch-track" aria-hidden="true"></span>
    <span class="featured-option-label">Include a Token Status List reference</span>
  </label>
  <p class="featured-option-hint">Why it matters, in one sentence.
    <a href="https://tsl.credimi.io/" target="_blank" rel="noreferrer">Token Status List service ↗</a></p>
</div>
```

### QR code, deeplink, and copy button

A QR code sits in a small white box, 12px of white around the code. The deeplink
it carries runs underneath at exactly the box's width, in monospace
`--brand-primary`, breaking at any character so every line but the last fills
the width; it is underlined only on hover. The deeplink is the one non-code
string kept in monospace: it is long, copied and compared character by
character, and only a fixed-width face fills every line evenly when it breaks
anywhere. Under the deeplink, a small copy
button: transparent with `--fg-muted` text, turning `--border` grey with `--fg`
text on hover, never the primary blue. Its copy icon is the one icon a button
may carry here, because it says what the button does.

```html
<div class="qr-box">…QR SVG…</div>
<div class="deeplink-panel" aria-label="Credential offer deeplink">
  <a class="deeplink" id="deeplink" href="openid-credential-offer://…">openid-credential-offer://…</a>
  <button class="btn btn-sm btn-copy" type="button">…copy icon…<span>Copy</span></button>
</div>
```

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

Always: name in sans-bold, dates in `.data`, pass-ratio in sans with the
fraction in `.data`, score pill on the right.

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

Section intro + `See all ↗` link at the end of its title row. Always underlined,
indigo, with the arrow-up-right glyph (Lucide `ArrowUpRight`).

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

The bottom strip closes the existing footer, after any content already there
and after the separate ForkBomb attribution sub-bar defined in
[§8](#8-layout--grid). It uses a translucent dark fill over the footer's own
brand background rather than a new colour. Its text is white at reduced
opacity, and in place of the trailing word it inlines the
`credimi_logo-transp_white.svg` wordmark at about 16px tall, with
`alt="Credimi"`.

The two footer sub-bars remain visually and semantically distinct: the
ForkBomb attribution comes first, and the Credimi Extras strip follows it.

Both Credimi Extras strips link to `https://credimi.io` in a new tab, with
`rel="noopener"`. Neither strip is sticky, dismissible, or animated, and
neither is clickable as a whole: only the trailing word or wordmark is an
anchor, never the bar. The sentence must read on one line at desktop width and
wrap rather than truncate at phone width, and the link must be keyboard
reachable with a visible focus state.

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

- ✓ Open every page with the hero band, and every section with a section intro.
- ✓ Sit forms and QR codes directly on the lavender wash; keep white cards for
  link cards and live panels.
- ✓ Keep cards hairline-bordered, shadow-less (link cards lift on hover only).
- ✓ Use Inter at 700 for display, 400–500 for body.
- ✓ Use `DD/MM/YYYY` for dates, `.data` for IDs; monospace only for code.
- ✓ Match status colors exactly to the semantic palette.
- ✓ Use the fold motif only in the hero band.
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
- ✗ Use rounded corners with a left-border accent color, except on the featured
  option ([§11](#11-components)).
- ✗ Use icons inside buttons unless the icon is semantically required.
- ✗ Use exclamation marks anywhere in the product UI.
- ✗ End a heading with a colon.
- ✗ Put an eyebrow above a hero or section title.
- ✗ Use the fold motif as body decoration.
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
`brand/style.css` today — 104 tokens defined, zero undefined `var()` references
— and it is what keeps a future edit from silently dropping a declaration.

---

## 17. Page layout update

On 25/11/2026 the page layout built for `credimi-capture-wallet` became the
brand layout. It is in `brand/style.css` after the utilities, and every class it
adds is documented in [§8](#8-layout--grid) and [§11](#11-components).

| Area | Before | After |
|---|---|---|
| Page header | lavender `.hero`, muted text, criss-cross motif | indigo `.hero-band`, white title and description, two-triangle fold motif |
| Sections | content on the lavender wash, inside white cards | `.page-section`s, 96px apart, optionally white; forms and QR codes uncarded |
| Section heading | `.section-header`, h2 with a trailing colon | `.section-intro`: blue title, rule, description; no colon |
| Card title | colon heading | `.panel-head`: sub-heading, chip, hairline; no colon |
| Eyebrow | above page titles | never above a hero or section title |

New components: link cards, disclosure, form row and form field, segmented
control, switch and featured option, QR box, deeplink, and the copy button.

Where the capture wallet's version broke an existing rule, the rule gives way:
the featured option keeps its 4px left edge as the one exception to the
left-border rule in [§15](#15-do--dont), and the segmented control is a rounded
rectangle rather than a pill. Link cards carry no shadow until hovered.
`--bg-muted` moved from the neutral `#F6F6F6` back to the faint lavender
`#FAF8FC` the capture wallet used, so muted surfaces stay in the brand's hue.

`.hero` and `.section-header` stay in the stylesheet, marked legacy, so the
applications built on them keep their look until each migrates in its own task.

The Credimi Design System project is the canonical specification and was not
updated by this change; it needs the same update so the two agree again.

---

## 18. Typography update

On 26/11/2026 Source Code Pro was narrowed to code. Everything else it used to
set moved to Inter, with `--font-data-features` (tabular digits, slashed zero,
disambiguation) wherever the text is data rather than prose
([§6](#6-typography)).

| Rule | Before | After |
|---|---|---|
| `.doc-id`, `.doc-id-display`, `.evidence-slug`, `.ref-source`, `.test-id` | Source Code Pro | Inter + `--font-data-features` |
| `.link-card-url` | Source Code Pro | Inter + `--font-data-features` |
| `.disclosure > summary::after` (˅ / ˄) | Source Code Pro | Inter |
| Dates, versions, run counts, identifiers in app markup | monospace | Inter + `.data` |
| `code`, `pre`, `.mono`, `.font-mono`, `.inline-code`, `.deeplink` | Source Code Pro | unchanged |

New: the `--font-data-features` token and the `.data` utility class.
Applications that set dates, versions or IDs in `.mono` or `.font-mono`
should switch those elements to `.data`; the classes themselves are unchanged
and now mean code only.

The Credimi Design System project is the canonical specification and was not
updated by this change; it still sets identifiers in monospace and needs the
same update so the two agree again.

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
