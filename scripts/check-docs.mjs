#!/usr/bin/env node
// Documentation consistency check for the Phase 0 document set.
//
// It is intentionally dependency-free so it can run before the application
// scaffold exists (plain Node, or Bun). It checks:
//   1. the five Phase 0 documents required by specification §18 exist;
//   2. local inline Markdown links and reference definitions resolve;
//   3. the five documents cross-reference each other, the authoritative
//      specification and the traceability matrix;
//   4. architecture decisions (AD-*), open questions (OQ-*) and capture
//      decisions (CD-*) are carried into docs/implementation-plan.md;
//   5. every Phase 1 issue #26–#39 has a row in the §9 dependency table.
//
// Reference-style uses without a definition (which render as text, not links)
// and angle-bracket targets containing spaces are not parsed; the repository
// documents do not use those forms.
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
const referenceDefinitionPattern = /^ {0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/gm;
const linksByFile = new Map();
let localLinkCount = 0;

for (const file of checkedFiles) {
  const text = readFileSync(file, 'utf8');
  // Keep line numbers stable while ignoring example links inside fenced code blocks
  // and inline code spans.
  const linkText = text
    .replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length));
  const targets = new Set();

  const addLocalLink = (rawValue, index) => {
    let raw = rawValue.trim();
    if (raw.startsWith('<') && raw.endsWith('>')) {
      raw = raw.slice(1, -1);
    }
    if (!raw || raw.startsWith('#')) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return; // http:, https:, mailto:, ...
    if (raw.startsWith('//')) return;

    const [pathPart] = raw.split('#');
    if (!pathPart) return;

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
      const line = text.slice(0, index).split('\n').length;
      fail(`${rel(file)}:${line}: broken local link -> ${raw}`);
    }
  };

  for (const match of linkText.matchAll(linkPattern)) {
    addLocalLink(match[1], match.index);
  }
  for (const match of linkText.matchAll(referenceDefinitionPattern)) {
    addLocalLink(match[2] ?? match[3], match.index);
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
const decisionPattern = /\b(?:AD|OQ|CD|D|R)-\d+\b/g;
const decisionIds = new Set();
for (const file of checkedFiles) {
  for (const match of readFileSync(file, 'utf8').matchAll(decisionPattern)) {
    decisionIds.add(match[0]);
  }
}
for (const id of [...decisionIds].sort()) {
  const idPattern = new RegExp(`\\b${id}\\b`);
  if (!idPattern.test(planText)) {
    fail(`${id} is referenced in the Phase 0 documents but not carried into docs/implementation-plan.md`);
  }
}

const phase1WaveTable = planText.split(/^## 9\./m)[1]?.split(/^## 10\./m)[0] ?? '';
for (let issue = 26; issue <= 39; issue += 1) {
  const row = new RegExp(`^\\|\\s*\\d+\\s*\\|[^\\n]*issues/${issue}(?:\\D|$)`, 'm');
  if (!row.test(phase1WaveTable)) {
    fail(`docs/implementation-plan.md §9: missing a dependency-table row for Phase 1 issue #${issue}`);
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
    `${localLinkCount} local links, ${decisionIds.size} decision references, ` +
    `Phase 1 wave table covers #26-#39)`,
);
