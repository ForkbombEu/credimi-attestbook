// Test fixture: reports the environment the launcher gave this child and the
// mode of its scratch directory, so a test can assert the exact allowlist and
// that the per-child directory is private.
import { statSync } from 'node:fs'

const temporaryDirectory = process.env.TMPDIR
process.stdout.write(
  JSON.stringify({
    env: process.env,
    tmpMode: temporaryDirectory === undefined ? null : statSync(temporaryDirectory).mode & 0o777,
  }),
)
