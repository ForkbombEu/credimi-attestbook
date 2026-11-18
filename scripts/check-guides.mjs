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
//   3. every inline and reference-style link in a rendered guide is safe and
//      resolves. Root-relative links must address a route the application
//      serves: `/guide/<slug>` must name a registered guide page, while `/docs`
//      and `/openapi.json` are permitted because they are intentionally
//      separate server documents. Relative links resolve against the guide's
//      public address, exactly as the browser resolves them. Only `http(s)` and
//      `mailto` external destinations are accepted; `javascript:`, `data:` and
//      other schemes are rejected, matching the runtime sanitizer in
//      `ui/src/markdown.ts`;
//   4. repository code/image paths cited in inline code exist, and local image
//      destinations resolve to a file the UI build serves under the site root.
//
// Published guide content is exactly `docs/guides/*.md`; the source-only
// architecture, specification and reference documents elsewhere in `docs/` are
// not guide pages and are not treated as such here.
//
// Usage: node scripts/check-guides.mjs
// Exit code 0 on success, 1 on any failure.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');
const guidesDir = resolve(root, 'docs/guides');
const registryPath = resolve(root, 'ui/src/guide.ts');
const publicDir = resolve(root, 'ui/public');

const failures = [];
const fail = (message) => failures.push(message);
const lineAt = (text, index) => text.slice(0, index).split('\n').length;
const isFile = (file) => existsSync(file) && statSync(file).isFile();
const ORIGIN = 'http://attestbook.invalid';

/**
 * A guide slug is the URL path segment and the Markdown file stem: lowercase
 * ASCII words joined by single hyphens.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Repository paths cited in inline code (and images) must exist. Only the
 * repository's own top-level source and documentation trees are considered;
 * upstream paths quoted from another repository are not.
 */
const CITATION_PATTERN =
  /^(?:docs|src|ui|scripts|research|migrations)\/[A-Za-z0-9_./-]+\.(?:md|markdown|ts|tsx|mjs|cjs|js|jsx|json|css|html|png|jpe?g|svg|webp|gif|ya?ml|toml)$/;

const FENCED_CODE_PATTERN = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm;
const INLINE_CODE_PATTERN = /`[^`\n]*`/g;
const INLINE_CODE_CONTENT_PATTERN = /`([^`\n]+)`/g;
const LINK_PATTERN = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const IMAGE_PATTERN = /!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const REFERENCE_DEFINITION_PATTERN = /^ {0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/gm;

/** Replaces fenced code blocks with spaces, keeping newlines and offsets. */
function maskFencedCode(text) {
  return text.replace(FENCED_CODE_PATTERN, (block) => block.replace(/[^\n]/g, ' '));
}

/** Replaces inline code spans with spaces, keeping newlines and offsets. */
function maskInlineCode(text) {
  return text.replace(INLINE_CODE_PATTERN, (span) => ' '.repeat(span.length));
}

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
function checkInternalPath(pathname, raw, source, line, slugs) {
  let path = pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    fail(`${source}:${line}: malformed percent-encoding in link -> ${raw}`);
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
        `${source}:${line}: missing guide target -> ${raw} ` +
          '(a guide address is /guide/<slug> and has one slug segment)',
      );
      return false;
    }
    if (!slugs.has(slug)) {
      fail(
        `${source}:${line}: missing guide target -> ${raw} ` +
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
    `${source}:${line}: unknown internal link target -> ${raw} ` +
      '(the guide may only link to a route the application serves)',
  );
  return false;
}

/**
 * Classifies a link destination and validates an internal one. Returns
 * `"external"`, `"internal"` or `null` when the destination is unsafe.
 */
function checkLinkDestination(raw, source, line, slug, slugs) {
  let destination = raw.trim();
  if (destination.startsWith('<') && destination.endsWith('>')) {
    destination = destination.slice(1, -1);
  }
  if (destination === '') {
    fail(`${source}:${line}: empty link destination`);
    return null;
  }
  const unsafeCharacter = [...destination].find((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x20 || code === 0x7f || character === '\\';
  });
  if (unsafeCharacter !== undefined) {
    fail(
      `${source}:${line}: unsafe link destination -> ${destination} ` +
        '(whitespace, control characters and backslashes are not allowed)',
    );
    return null;
  }
  if (destination.startsWith('//')) {
    fail(`${source}:${line}: unsafe link destination -> ${destination} (protocol-relative)`);
    return null;
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(destination);
  if (scheme !== null) {
    const name = scheme[1].toLowerCase();
    if (name === 'http' || name === 'https' || name === 'mailto') {
      return 'external';
    }
    fail(
      `${source}:${line}: unsafe link scheme "${name}:" -> ${destination} ` +
        '(only http(s), mailto and application routes become links)',
    );
    return null;
  }

  let url;
  try {
    url = new URL(destination, `${ORIGIN}/guide/${encodeURIComponent(slug)}`);
  } catch {
    fail(`${source}:${line}: malformed link destination -> ${destination}`);
    return null;
  }
  if (url.origin !== ORIGIN) {
    fail(`${source}:${line}: unsafe link destination -> ${destination}`);
    return null;
  }
  checkInternalPath(url.pathname, destination, source, line, slugs);
  return 'internal';
}

/** Validates an image destination against the files the UI build serves. */
function checkImageDestination(raw, source, line, slug) {
  const destination = raw.trim();
  if (destination === '') {
    fail(`${source}:${line}: empty image destination`);
    return;
  }
  const unsafeCharacter = [...destination].find((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x20 || code === 0x7f || character === '\\';
  });
  if (unsafeCharacter !== undefined) {
    fail(`${source}:${line}: unsafe image destination -> ${destination}`);
    return;
  }
  if (destination.startsWith('//')) {
    fail(`${source}:${line}: unsafe image destination -> ${destination} (protocol-relative)`);
    return;
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(destination);
  if (scheme !== null) {
    const name = scheme[1].toLowerCase();
    if (name === 'http' || name === 'https') {
      return;
    }
    fail(`${source}:${line}: unsafe image scheme "${name}:" -> ${destination}`);
    return;
  }

  let path;
  try {
    path = decodeURIComponent(
      new URL(destination, `${ORIGIN}/guide/${encodeURIComponent(slug)}`).pathname,
    );
  } catch {
    fail(`${source}:${line}: malformed image destination -> ${destination}`);
    return;
  }
  // Vite copies `ui/public/<path>` to `dist/ui/<path>`, so a root-relative image
  // path is served from the public directory.
  const candidate = resolve(publicDir, `.${path}`);
  if (candidate !== publicDir && !candidate.startsWith(`${publicDir}${sep}`)) {
    fail(`${source}:${line}: image destination escapes ui/public -> ${destination}`);
    return;
  }
  if (!isFile(candidate)) {
    fail(
      `${source}:${line}: missing local image asset -> ${destination} ` +
        `(expected ui/public${path})`,
    );
  }
}

/** Validates the rendered Markdown links and assets of one registered guide. */
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

  const withoutFences = maskFencedCode(markdown);
  const withoutCode = maskInlineCode(withoutFences);
  if (/^ {0,3}#[ \t]+\S/m.test(withoutFences)) {
    fail(
      `${file}: the guide body must not have a level-1 heading; ` +
        'the registered title is the page h1',
    );
  }

  let internal = 0;
  let external = 0;
  let assets = 0;

  for (const match of withoutCode.matchAll(LINK_PATTERN)) {
    const result = checkLinkDestination(
      match[1],
      file,
      lineAt(markdown, match.index),
      slug,
      slugs,
    );
    if (result === 'internal') internal += 1;
    if (result === 'external') external += 1;
  }
  for (const match of withoutCode.matchAll(REFERENCE_DEFINITION_PATTERN)) {
    const target = match[2] ?? match[3];
    const result = checkLinkDestination(
      target,
      file,
      lineAt(markdown, match.index),
      slug,
      slugs,
    );
    if (result === 'internal') internal += 1;
    if (result === 'external') external += 1;
  }
  for (const match of withoutCode.matchAll(IMAGE_PATTERN)) {
    checkImageDestination(match[1], file, lineAt(markdown, match.index), slug);
    assets += 1;
  }
  for (const match of withoutFences.matchAll(INLINE_CODE_CONTENT_PATTERN)) {
    const citation = match[1].trim();
    if (!CITATION_PATTERN.test(citation)) {
      continue;
    }
    assets += 1;
    if (!isFile(resolve(root, citation))) {
      fail(
        `${file}:${lineAt(markdown, match.index)}: cited local code/image asset ` +
          `does not exist -> ${citation}`,
      );
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
