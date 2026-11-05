#!/usr/bin/env node
// Documentation consistency check for the Phase 0 document set.
//
// It is intentionally dependency-free so it can run before the application
// scaffold exists (plain Node, or Bun). It checks:
//   1. the five Phase 0 documents required by specification §18 exist;
//   2. every local Markdown link in the checked files resolves;
//   3. the five documents cross-reference each other, the authoritative
//      specification and the traceability matrix;
//   4. architecture decisions (AD-*), open questions (OQ-*) and capture
//      decisions (CD-*) are carried into docs/implementation-plan.md;
//   5. the migrated Phase 1 backlog (#26–#39) is present in the plan.
//
// Usage: node scripts/check-docs.mjs
// Exit code 0 on success, 1 on any failure.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');
const docsDir = resolve(root, 'docs');

const requiredDocs = [
  'architecture.md',
  'standards.md',
  'requirements.md',
  'capture-integration.md',
  'implementation-plan.md',
];
const supportingDocs = ['specification.md', 'traceability.md'];
const planPath = resolve(docsDir, 'implementation-plan.md');

const failures = [];
const fail = (message) => failures.push(message);
const rel = (file) => relative(root, file).split('\\').join('/');

for (const name of requiredDocs) {
  const file = resolve(docsDir, name);
  if (!existsSync(file) || !statSync(file).isFile()) {
    fail(`missing required Phase 0 document: docs/${name}`);
    continue;
  }
  const text = readFileSync(file, 'utf8').trim();
  if (!text.startsWith('# ')) {
    fail(`docs/${name} does not start with a level-1 heading`);
  }
  if (text.length < 200) {
    fail(`docs/${name} looks empty (${text.length} characters)`);
  }
}

const checkedFiles = [
  ...readdirSync(docsDir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => resolve(docsDir, name)),
  resolve(root, 'AGENTS.md'),
  resolve(root, 'research/owf-audit/README.md'),
].filter((file) => existsSync(file) && statSync(file).isFile());

const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const linksByFile = new Map();
let localLinkCount = 0;

for (const file of checkedFiles) {
  const text = readFileSync(file, 'utf8');
  // Keep line numbers stable while ignoring example links inside fenced code blocks.
  const linkText = text.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, (block) =>
    block.replace(/[^\n]/g, ' '),
  );
  const targets = new Set();

  for (const match of linkText.matchAll(linkPattern)) {
    let raw = match[1].trim();
    if (raw.startsWith('<') && raw.endsWith('>')) {
      raw = raw.slice(1, -1);
    }
    if (!raw || raw.startsWith('#')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue; // http:, https:, mailto:, ...
    if (raw.startsWith('//')) continue;

    const [pathPart] = raw.split('#');
    if (!pathPart) continue;

    let decoded = pathPart;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      // Keep the raw path so the broken-link report names what the document says.
    }

    const target = decoded.startsWith('/')
      ? resolve(root, `.${decoded}`)
      : resolve(dirname(file), decoded);

    targets.add(target);
    localLinkCount += 1;

    if (!existsSync(target)) {
      const line = text.slice(0, match.index).split('\n').length;
      fail(`${rel(file)}:${line}: broken local link -> ${raw}`);
    }
  }

  linksByFile.set(file, targets);
}

for (const name of requiredDocs) {
  const file = resolve(docsDir, name);
  const targets = linksByFile.get(file) ?? new Set();
  const references = [
    ...requiredDocs.filter((other) => other !== name),
    ...supportingDocs,
  ];
  for (const other of references) {
    if (!targets.has(resolve(docsDir, other))) {
      fail(`docs/${name}: missing cross-reference to docs/${other}`);
    }
  }
}

const planText = existsSync(planPath) ? readFileSync(planPath, 'utf8') : '';
const decisionPattern = /\b(?:AD|OQ|CD)-\d+\b/g;
const decisionIds = new Set();
for (const file of checkedFiles) {
  for (const match of readFileSync(file, 'utf8').matchAll(decisionPattern)) {
    decisionIds.add(match[0]);
  }
}
for (const id of [...decisionIds].sort()) {
  if (!planText.includes(id)) {
    fail(`${id} is referenced in the Phase 0 documents but not carried into docs/implementation-plan.md`);
  }
}

for (let issue = 26; issue <= 39; issue += 1) {
  if (!planText.includes(`issues/${issue}`)) {
    fail(`docs/implementation-plan.md: missing migrated Phase 1 issue #${issue}`);
  }
}

if (failures.length > 0) {
  console.error(`docs-check: ${failures.length} failure(s)`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(
  `docs-check: OK (${requiredDocs.length} required documents, ${checkedFiles.length} files, ` +
    `${localLinkCount} local links, ${decisionIds.size} decision references, #26-#39 covered)`,
);
