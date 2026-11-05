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
