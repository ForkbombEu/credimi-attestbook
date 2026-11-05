import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'attestbook-docs-check-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'research', 'owf-audit'), { recursive: true });
  cpSync(join(repoRoot, 'scripts', 'check-docs.mjs'), join(root, 'scripts', 'check-docs.mjs'));
  cpSync(join(repoRoot, 'docs'), join(root, 'docs'), { recursive: true });
  cpSync(join(repoRoot, 'AGENTS.md'), join(root, 'AGENTS.md'));
  cpSync(
    join(repoRoot, 'research', 'owf-audit', 'README.md'),
    join(root, 'research', 'owf-audit', 'README.md'),
  );
  cpSync(
    join(repoRoot, 'research', 'owf-audit', 'probe.mjs'),
    join(root, 'research', 'owf-audit', 'probe.mjs'),
  );
  return root;
}

function runChecker(root) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'check-docs.mjs')], {
    encoding: 'utf8',
  });
}

test('passes on the repository documentation', () => {
  const root = makeFixture();
  try {
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /docs-check: OK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails on a broken inline link', () => {
  const root = makeFixture();
  try {
    const doc = join(root, 'docs', 'architecture.md');
    writeFileSync(doc, `${readFileSync(doc, 'utf8')}\n[broken](missing.md)\n`);
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /broken local link -> missing\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails on a broken reference-style link definition', () => {
  const root = makeFixture();
  try {
    const doc = join(root, 'docs', 'architecture.md');
    writeFileSync(doc, `${readFileSync(doc, 'utf8')}\n[broken-ref]: missing-reference.md\n`);
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /broken local link -> missing-reference\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function mutate(root, relativePath, change) {
  const file = join(root, relativePath);
  writeFileSync(file, change(readFileSync(file, 'utf8')));
}

test('fails when a required document is missing', () => {
  const root = makeFixture();
  try {
    rmSync(join(root, 'docs', 'requirements.md'));
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing required Phase 0 document: docs\/requirements\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails when a required document has no level-1 heading', () => {
  const root = makeFixture();
  try {
    mutate(root, 'docs/architecture.md', (text) => text.replace(/^# [^\n]*\n/, ''));
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /docs\/architecture\.md does not start with a level-1 heading/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails when a required cross-reference is missing', () => {
  const root = makeFixture();
  try {
    mutate(root, 'docs/architecture.md', (text) =>
      text.replaceAll('](requirements.md)', '](architecture.md)'),
    );
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /docs\/architecture\.md: missing cross-reference to docs\/requirements\.md/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails when a decision is not carried into the implementation plan', () => {
  const root = makeFixture();
  try {
    mutate(root, 'docs/implementation-plan.md', (text) => text.replaceAll('OQ-3', 'OQ-removed'));
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /OQ-3 is referenced in the Phase 0 documents but not carried into docs\/implementation-plan\.md/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails when a Phase 1 wave-table row is missing', () => {
  const root = makeFixture();
  try {
    mutate(root, 'docs/implementation-plan.md', (text) =>
      text.replace(/^\| 1 \| \[#26\][^\n]*\n/m, ''),
    );
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /docs\/implementation-plan\.md §9: missing a dependency-table row for Phase 1 issue #26/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
