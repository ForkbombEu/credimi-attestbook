#!/usr/bin/env node
// Consistency check for the public Markdown product guide served at `/guide`.
//
// The guide is repository-owned Markdown in `docs/guides/` plus one registry
// entry per page in `ui/src/guide.ts`, which is the single source of truth for
// the page slugs, titles, descriptions and bundled Markdown. This check is
// intentionally dependency-free, deterministic and offline, so a guide-only
// pull request is verified without building or serving the application. It
// checks:
//   1. every `docs/guides/*.md` file is registered exactly once, its slug
//      matches the file name, and no slug is duplicate or malformed;
//   2. every registry entry carries the route metadata the guide index needs
//      (a slug, a title and a one-sentence description), and the Markdown body
//      has no level-1 heading because the registered title is the page `h1`;
//   3. every link the runtime renderer turns into an anchor is safe and
//      resolves. Root-relative links must address a route the application
//      serves: `/guide/<slug>` must name a registered guide page, while `/docs`
//      and `/openapi.json` are permitted because they are intentionally
//      separate server documents. `#fragment`, `https://`, `http://` and
//      `mailto:` destinations are accepted; any other destination is not a link
//      in the rendered guide, so it is rejected here too. The same applies to
//      link syntax inside `**bold**` or `*italic*` text, which the renderer
//      shows verbatim rather than parsing again;
//   4. repository code paths cited in inline code exist. Inline images and
//      reference-style links are not rendered by the guide, so they are
//      rejected as well.
//
// Links are read with the same `parseMarkdown` and `parseInline` functions the
// guide page uses (`ui/src/markdown.ts`), which Node loads directly by stripping
// its TypeScript types. The authoring rules therefore cannot drift from the
// renderer that publishes the page.
//
// Published guide content is exactly `docs/guides/*.md`; the source-only
// architecture, specification and reference documents elsewhere in `docs/` are
// not guide pages and are not treated as such here.
//
// Usage: node scripts/check-guides.mjs
// Exit code 0 on success, 1 on any failure.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');
const guidesDir = resolve(root, 'docs/guides');
const registryPath = resolve(root, 'ui/src/guide.ts');

const failures = [];
const fail = (message) => failures.push(message);
const lineAt = (text, index) => text.slice(0, index).split('\n').length;
const isFile = (file) => existsSync(file) && statSync(file).isFile();
const ORIGIN = 'http://attestbook.invalid';

const { parseMarkdown, parseInline } = await import(
  pathToFileURL(resolve(root, 'ui/src/markdown.ts')).href
);

/**
 * A guide slug is the URL path segment and the Markdown file stem: lowercase
 * ASCII words joined by single hyphens.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Repository paths cited in inline code must exist. Only the repository's own
 * top-level source and documentation trees are considered; upstream paths
 * quoted from another repository are not.
 */
const CITATION_PATTERN =
  /^(?:docs|src|ui|scripts|research|migrations)\/[A-Za-z0-9_./-]+\.(?:md|markdown|ts|tsx|mjs|cjs|js|jsx|json|css|html|png|jpe?g|svg|webp|gif|ya?ml|toml)$/;

/** Reads one quoted registry value, tolerating escaped quotes and line wraps. */
function readRegistryString(block, field) {
  const match = new RegExp(`\\b${field}:\\s*`).exec(block);
  if (match === null) {
    return null;
  }
  let index = match.index + match[0].length;
  const quote = block[index];
  if (quote !== "'" && quote !== '"') {
    return null;
  }
  let value = '';
  index += 1;
  while (index < block.length) {
    const character = block[index];
    if (character === '\\') {
      const escaped = block[index + 1];
      value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : (escaped ?? '');
      index += 2;
      continue;
    }
    if (character === quote) {
      return value;
    }
    value += character;
    index += 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Registry and page metadata
// ---------------------------------------------------------------------------

const importsByBinding = new Map();
const registryText = isFile(registryPath) ? readFileSync(registryPath, 'utf8') : '';
if (registryText === '') {
  fail('missing guide registry: ui/src/guide.ts');
}

const importPattern =
  /import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+['"]\.\.\/\.\.\/docs\/guides\/([^'"/]+\.md)\?raw['"]/g;
for (const match of registryText.matchAll(importPattern)) {
  const binding = match[1];
  const file = `docs/guides/${match[2]}`;
  if (importsByBinding.has(binding)) {
    fail(`ui/src/guide.ts: duplicate import binding "${binding}"`);
    continue;
  }
  importsByBinding.set(binding, file);
}

const registryBody = registryText.includes('export const GUIDE_DOCUMENTS')
  ? registryText.slice(registryText.indexOf('export const GUIDE_DOCUMENTS'))
  : '';
const entryBlocks = [...registryBody.matchAll(/\{[^{}]*\bmarkdown:\s*[A-Za-z_$][A-Za-z0-9_$]*[^{}]*\}/g)].map(
  (match) => match[0],
);
const markdownFieldCount = (registryBody.match(/\bmarkdown:/g) ?? []).length;
if (entryBlocks.length !== markdownFieldCount) {
  fail(
    'ui/src/guide.ts: could not parse every guide registry entry; keep the ' +
      '`slug`/`title`/`description`/`markdown` entry shape used by scripts/check-guides.mjs',
  );
}

const guidesBySlug = new Map();
const registeredFiles = new Set();
const usedBindings = new Set();
let entryCount = 0;

for (const block of entryBlocks) {
  entryCount += 1;
  const slug = readRegistryString(block, 'slug');
  const title = readRegistryString(block, 'title');
  const description = readRegistryString(block, 'description');
  const bindingMatch = /\bmarkdown:\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(block);
  const binding = bindingMatch === null ? null : bindingMatch[1];

  if (slug === null || slug === '') {
    fail(`ui/src/guide.ts: entry ${entryCount} has no route slug`);
  }
  if (title === null || title.trim() === '') {
    fail(`ui/src/guide.ts: guide "${slug ?? `entry ${entryCount}`}" has no title`);
  }
  if (description === null || description.trim() === '') {
    fail(
      `ui/src/guide.ts: guide "${slug ?? `entry ${entryCount}`}" has no description ` +
        '(the guide index card needs one)',
    );
  }
  if (slug !== null && slug !== '' && !SLUG_PATTERN.test(slug)) {
    fail(
      `ui/src/guide.ts: malformed guide slug "${slug}" ` +
        '(use lowercase kebab-case: letters, digits and single hyphens)',
    );
  }
  if (binding === null) {
    fail(`ui/src/guide.ts: guide "${slug ?? `entry ${entryCount}`}" has no Markdown import`);
    continue;
  }
  if (usedBindings.has(binding)) {
    fail(`ui/src/guide.ts: Markdown import "${binding}" is registered more than once`);
  }
  usedBindings.add(binding);

  const file = importsByBinding.get(binding);
  if (file === undefined) {
    fail(
      `ui/src/guide.ts: guide "${slug ?? `entry ${entryCount}`}" imports "${binding}", ` +
        'which is not a docs/guides/*.md import',
    );
    continue;
  }
  if (slug !== null && slug !== '' && file !== `docs/guides/${slug}.md`) {
    fail(
      `ui/src/guide.ts: guide slug "${slug}" does not match its Markdown file ${file} ` +
        `(expected docs/guides/${slug}.md)`,
    );
  }
  if (guidesBySlug.has(slug)) {
    fail(`ui/src/guide.ts: duplicate guide slug "${slug}"`);
  } else {
    guidesBySlug.set(slug, { file, title, description });
  }
  registeredFiles.add(file);
}

for (const [binding, file] of importsByBinding) {
  if (!usedBindings.has(binding)) {
    fail(`ui/src/guide.ts: import "${binding}" (${file}) is not registered in GUIDE_DOCUMENTS`);
  }
}

const guideFiles = existsSync(guidesDir)
  ? readdirSync(guidesDir)
      .filter((name) => name.endsWith('.md'))
      .sort()
  : [];
for (const name of guideFiles) {
  const file = `docs/guides/${name}`;
  if (!registeredFiles.has(file)) {
    fail(
      `${file}: guide Markdown is not registered in ui/src/guide.ts, so it would never ` +
        'be published; add a slug, title and description',
    );
  }
}

// ---------------------------------------------------------------------------
// Link and asset resolution
// ---------------------------------------------------------------------------

/** True for the routes the application serves for guide pages and app views. */
function checkInternalPath(pathname, raw, source, location, slugs) {
  let path = pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    fail(`${source}${location}: malformed percent-encoding in link -> ${raw}`);
    return false;
  }
  while (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  if (path === '/') {
    return true;
  }
  if (path === '/guide') {
    return true;
  }
  if (path.startsWith('/guide/')) {
    const slug = path.slice('/guide/'.length);
    if (slug.includes('/')) {
      fail(
        `${source}${location}: missing guide target -> ${raw} ` +
          '(a guide address is /guide/<slug> and has one slug segment)',
      );
      return false;
    }
    if (!slugs.has(slug)) {
      fail(
        `${source}${location}: missing guide target -> ${raw} ` +
          `(no registered guide page for "${slug}")`,
      );
      return false;
    }
    return true;
  }
  // `/docs` is the separate Scalar reference document and `/openapi.json` is the
  // generated contract; both are intentionally outside the guide page set.
  if (path === '/docs' || path === '/openapi.json') {
    return true;
  }
  // The application views and public static mounts served by the SPA. Keep this
  // list matched to `isClientRoute` in ui/src/router.tsx and the static routes
  // in src/app.ts.
  if (
    path === '/playground' ||
    path === '/captures' ||
    path.startsWith('/captures/') ||
    path === '/login' ||
    path.startsWith('/rulebooks/') ||
    path.startsWith('/assets/') ||
    path.startsWith('/brand/')
  ) {
    return true;
  }
  fail(
    `${source}${location}: unknown internal link target -> ${raw} ` +
      '(the guide may only link to a route the application serves)',
  );
  return false;
}

/** Validates the rendered Markdown links and inline-code citations of one guide. */
function checkGuideContent(file, slug, slugs) {
  if (!isFile(resolve(root, file))) {
    fail(`${file}: registered guide Markdown file does not exist`);
    return { internal: 0, external: 0, assets: 0 };
  }
  const markdown = readFileSync(resolve(root, file), 'utf8');
  if (markdown.trim() === '') {
    fail(`${file}: registered guide Markdown is empty`);
    return { internal: 0, external: 0, assets: 0 };
  }

  const location = (snippet) => {
    const index = markdown.indexOf(snippet);
    return index < 0 ? '' : `:${lineAt(markdown, index)}`;
  };

  let internal = 0;
  let external = 0;
  let assets = 0;

  for (const block of parseMarkdown(markdown)) {
    if (block.type === 'code') {
      continue; // Fenced code is displayed, never rendered as Markdown.
    }
    if (block.type === 'heading' && block.level === 1) {
      fail(
        `${file}${location(block.text)}: the guide body must not have a level-1 heading; ` +
          'the registered title is the page h1',
      );
    }

    const texts = block.type === 'list' ? block.items : [block.text];
    for (const text of texts) {
      // The renderer has no image support. It shows `![alt](...)` as the
      // literal `!` followed by the link text, so an image is always broken.
      const image = /!\[[^\]]*\]\([^)]*\)/.exec(text);
      if (image !== null) {
        fail(
          `${file}${location(image[0])}: image syntax is not rendered by the guide -> ${image[0]}`,
        );
      }

      for (const token of parseInline(text)) {
        if (token.type === 'link') {
          if (token.href.startsWith('#')) {
            internal += 1;
            continue;
          }
          if (token.href.startsWith('/')) {
            checkInternalPath(
              new URL(token.href, ORIGIN).pathname,
              token.href,
              file,
              location(token.href),
              slugs,
            );
            internal += 1;
            continue;
          }
          external += 1;
          continue;
        }

        if (token.type === 'code') {
          const citation = token.text.trim();
          if (!CITATION_PATTERN.test(citation)) {
            continue;
          }
          assets += 1;
          if (!isFile(resolve(root, citation))) {
            fail(
              `${file}${location(citation)}: cited local code/image asset ` +
                `does not exist -> ${citation}`,
            );
          }
          continue;
        }

        // text, strong and emphasis tokens are all displayed verbatim: link
        // syntax inside any of them is literal text on the published page.
        if (token.type !== 'text' && token.type !== 'strong' && token.type !== 'emphasis') {
          continue;
        }
        const inside =
          token.type === 'text'
            ? ''
            : ' (links inside **bold** or *italic* text are not rendered)';
        // Anything the renderer refused to turn into a link stays literal text
        // in the published page; that is a broken guide link, not a valid one.
        for (const match of token.text.matchAll(/\[[^\]]*\]\(([^)]*)\)/g)) {
          const destination = match[1].trim();
          const lower = destination.toLowerCase();
          const unsafe =
            /^(javascript|data|vbscript|file):/.test(lower) ||
            lower.startsWith('//') ||
            [...destination].some((character) => {
              const code = character.codePointAt(0) ?? 0;
              return code < 0x20 || code === 0x7f || character === '\\';
            });
          if (unsafe) {
            fail(
              `${file}${location(match[0])}: unsafe link destination -> ${destination}` +
                (lower.startsWith('//') ? ' (protocol-relative)' : '') +
                inside,
            );
          } else {
            fail(
              `${file}${location(match[0])}: link renders as literal text -> ${destination} ` +
                '(use a root-relative /guide/<slug>, #fragment, https://, http:// or ' +
                `mailto: link with a non-empty label and no title)${inside}`,
            );
          }
        }
        if (
          /^\s*\[[^\]]+\]:\s*\S/.test(token.text) ||
          /\[[^\]]+\]\[[^\]]*\]/.test(token.text)
        ) {
          fail(
            `${file}${location(token.text)}: reference-style links are not rendered by the guide`,
          );
        }
      }
    }
  }

  return { internal, external, assets };
}


const slugs = new Set(guidesBySlug.keys());
let internalLinks = 0;
let externalLinks = 0;
let assetCitations = 0;
for (const [slug, guide] of guidesBySlug) {
  const result = checkGuideContent(guide.file, slug, slugs);
  internalLinks += result.internal;
  externalLinks += result.external;
  assetCitations += result.assets;
}

if (failures.length > 0) {
  console.error(`guide-check: ${failures.length} failure(s)`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(
  `guide-check: OK (${entryCount} guide pages, ${guideFiles.length} Markdown files, ` +
    `${internalLinks} internal links, ${externalLinks} external links, ` +
    `${assetCitations} local assets)`,
);
