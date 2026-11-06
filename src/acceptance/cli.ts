// CLI for the Phase 1 end-to-end acceptance workflow (issue #39).
//
// Run from the repository root:
//
//   bun run acceptance
//
// It builds no services of its own: the workflow uses a temporary SQLite
// database, the real migrations and the in-process HTTP application. The built
// UI is required (`bun run build` produces it); the workflow fails if
// `dist/ui/index.html` is missing. The dimension-aware evidence is written to
// `ACCEPTANCE_EVIDENCE_PATH` (default `dist/acceptance-evidence.json`).

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { AcceptanceError, runAcceptance } from './workflow'

const evidencePath = resolve(Bun.env.ACCEPTANCE_EVIDENCE_PATH ?? 'dist/acceptance-evidence.json')

try {
  const { evidence, checks } = await runAcceptance()
  mkdirSync(dirname(evidencePath), { recursive: true })
  writeFileSync(`${evidencePath}`, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

  const passed = checks.filter((check) => check.passed).length
  console.log(`Phase 1 acceptance: ${passed}/${checks.length} checks passed`)

  const statuses = evidence.valid.dimensions
    .map((dimension) => `${dimension.id}=${dimension.status}`)
    .join(' ')
  console.log(`Structural validation overall=${evidence.valid.overallStatus} ${statuses}`)
  console.log(`Rulebook ${evidence.rulebook.id} version ${evidence.version.label}`)
  console.log(`Snapshot digest ${evidence.version.contentDigest}`)
  console.log(`Evidence written to ${evidencePath}`)
} catch (error) {
  if (error instanceof AcceptanceError) {
    console.error(error.message)
    for (const check of error.checks.filter((candidate) => !candidate.passed)) {
      if (check.detail !== undefined) {
        console.error(`  ${check.id}: ${check.detail}`)
      }
    }
    process.exit(1)
  }
  console.error(error)
  process.exit(1)
}
