import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function camelCase(file) {
  return file.replace(/-([a-z0-9])/g, (_, character) => character.toUpperCase());
}

function defaultGuides() {
  return [
    {
      slug: 'introduction',
      title: 'Introduction to the guide',
      description: 'Where to start reading.',
      body: `Start with [Core concepts](concepts), the [guide overview](/guide), the
[API reference](/docs), the [OpenAPI contract](/openapi.json), the
[playground](/playground), a [new rulebook](/rulebooks/new), or an
[external site](https://example.org).

Write to [the team](mailto:team@example.org) and read
\`docs/ui.md\` for the UI notes and \`src/example.ts\` for the sample.

![Guide diagram](assets/diagram.png)
`,
    },
    {
      slug: 'concepts',
      title: 'Core concepts',
      description: 'The guide vocabulary.',
      body: `## Concepts

Return to the [introduction](introduction) and read
the [rulebook routes](/rulebooks/new).
`,
    },
  ];
}

/**
 * Builds a disposable repository containing the checker, a guide registry, the
 * registered Markdown pages and the files those guides cite.
 */
function makeFixture(guides = defaultGuides()) {
  const root = mkdtempSync(join(tmpdir(), 'attestbook-guide-check-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'ui', 'src'), { recursive: true });
  mkdirSync(join(root, 'ui', 'public', 'guide', 'assets'), { recursive: true });
  mkdirSync(join(root, 'docs', 'guides'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });

  cpSync(join(repoRoot, 'scripts', 'check-guides.mjs'), join(root, 'scripts', 'check-guides.mjs'));
  writeFileSync(join(root, 'docs', 'ui.md'), '# UI notes\n\nThe source-only documentation check.\n');
  writeFileSync(join(root, 'src', 'example.ts'), 'export {};\n');
  writeFileSync(join(root, 'ui', 'public', 'guide', 'assets', 'diagram.png'), 'fixture image\n');

  const imports = [];
  const blocks = [];
  for (const guide of guides) {
    const file = guide.file ?? guide.slug;
    const binding = `${camelCase(file)}Markdown`;
    imports.push(`import ${binding} from '../../docs/guides/${file}.md?raw';`);
    blocks.push(
      `  {
    slug: '${guide.slug}',
    title: '${guide.title}',
    description: '${guide.description}',
    markdown: ${binding},
  },`,
    );
    writeFileSync(join(root, 'docs', 'guides', `${file}.md`), guide.body);
  }

  writeFileSync(
    join(root, 'ui', 'src', 'guide.ts'),
    `// Fixture registry for scripts/check-guides.test.mjs.
//
// Page convention for adding a guide: register the page below with a slug, a
// title and a description.

${imports.join('\n')}

export const GUIDE_DOCUMENTS = [
${blocks.join('\n')}
];
`,
  );

  return root;
}

function runChecker(root) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'check-guides.mjs')], {
    encoding: 'utf8',
  });
}

function mutate(root, relativePath, change) {
  const file = join(root, relativePath);
  writeFileSync(file, change(readFileSync(file, 'utf8')));
}

function withFixture(run) {
  const root = makeFixture();
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('passes on the repository guide content', () => {
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'check-guides.mjs')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /guide-check: OK \(\d+ guide pages/);
});

test('passes on valid guide links, route metadata and local assets', () => {
  withFixture((root) => {
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /guide-check: OK \(2 guide pages, 2 Markdown files/);
  });
});

test('accepts reference-style links and same-page fragments', () => {
  withFixture((root) => {
    mutate(root, 'docs/guides/concepts.md', (text) =>
      `${text}\n[guide]: /guide\n[concepts]: concepts\n[jump](#concepts)\n`,
    );
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
  });
});

test('fails on a link to an unregistered guide page', () => {
  withFixture((root) => {
    mutate(root, 'docs/guides/introduction.md', (text) =>
      `${text}\n[missing](/guide/does-not-exist)\n`,
    );
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing guide target -> \/guide\/does-not-exist/);
  });
});

test('fails on a relative link whose resolved guide page is not registered', () => {
  withFixture((root) => {
    mutate(root, 'docs/guides/introduction.md', (text) => `${text}\n[missing](does-not-exist)\n`);
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing guide target -> does-not-exist/);
  });
});

test('fails on an internal link to a route the application does not serve', () => {
  withFixture((root) => {
    mutate(root, 'docs/guides/introduction.md', (text) => `${text}\n[catalog](/catlog)\n`);
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown internal link target -> \/catlog/);
  });
});

test('fails on a javascript: link', () => {
  withFixture((root) => {
    mutate(root, 'docs/guides/introduction.md', (text) =>
      `${text}\n[run](javascript:alert(1))\n`,
    );
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsafe link scheme "javascript:"/);
  });
});

test('fails on a data: link', () => {
  withFixture((root) => {
    mutate(root, 'docs/guides/introduction.md', (text) =>
      `${text}\n[download](data:text/html,hello)\n`,
    );
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsafe link scheme "data:"/);
  });
});

test('fails on a protocol-relative link', () => {
  withFixture((root) => {
    mutate(root, 'docs/guides/introduction.md', (text) =>
      `${text}\n[elsewhere](//evil.example/path)\n`,
    );
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /protocol-relative/);
  });
});

test('fails on duplicate guide slugs', () => {
  const guides = defaultGuides();
  guides[1].slug = 'introduction';
  const root = makeFixture(guides);
  try {
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /duplicate guide slug "introduction"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails on a malformed guide slug', () => {
  const guides = defaultGuides();
  guides[1].slug = 'introduction_page';
  guides[1].file = 'introduction_page';
  const root = makeFixture(guides);
  try {
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /malformed guide slug "introduction_page"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails when a guide Markdown file is not registered', () => {
  withFixture((root) => {
    writeFileSync(join(root, 'docs', 'guides', 'extra.md'), '## Extra\n\nUnregistered page.\n');
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /docs\/guides\/extra\.md: guide Markdown is not registered/);
  });
});

test('fails when a registered guide Markdown file is missing', () => {
  withFixture((root) => {
    rmSync(join(root, 'docs', 'guides', 'concepts.md'));
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /registered guide Markdown file does not exist/);
  });
});

test('fails when the route title is missing', () => {
  const guides = defaultGuides();
  guides[0].title = '';
  const root = makeFixture(guides);
  try {
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /has no title/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails when the route description is missing', () => {
  const guides = defaultGuides();
  guides[0].description = '';
  const root = makeFixture(guides);
  try {
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /has no description/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails when a guide body has a level-1 heading', () => {
  withFixture((root) => {
    mutate(root, 'docs/guides/concepts.md', () => '# Core concepts\n\nText.\n');
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not have a level-1 heading/);
  });
});

test('does not treat an unregistered internal document as guide content', () => {
  withFixture((root) => {
    writeFileSync(
      join(root, 'docs', 'architecture.md'),
      '# Architecture\n\nSee `docs/missing.md` and [bad](/guide/missing).\n',
    );
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
  });
});

test('ignores links, images and citations inside fenced code blocks', () => {
  withFixture((root) => {
    mutate(root, 'docs/guides/concepts.md', (text) =>
      `${text}\n\`\`\`md\n[bad](javascript:alert(1))\n![bad](missing.png)\n\`src/missing.ts\`\n\`\`\`\n`,
    );
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
  });
});

test('fails when a guide cites a missing local code asset', () => {
  withFixture((root) => {
    mutate(root, 'docs/guides/concepts.md', (text) => `${text}\nUse \`src/missing.ts\`.\n`);
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cited local code\/image asset does not exist -> src\/missing\.ts/);
  });
});

test('fails when a guide references a missing local image asset', () => {
  withFixture((root) => {
    mutate(root, 'docs/guides/concepts.md', (text) => `${text}\n![gone](assets/gone.png)\n`);
    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing local image asset -> assets\/gone\.png/);
  });
});
