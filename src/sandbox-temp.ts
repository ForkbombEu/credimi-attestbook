// Shared location of the sandbox scratch directory (issue #114).
//
// Both the configuration layer (which decides where the base directory is) and
// the sandbox launcher (which creates one private directory per child) use the
// same default name, so a deployment and its worker never disagree about the
// path.

import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Name of the private sandbox scratch directory used by default. */
export const SANDBOX_TEMP_DIRECTORY_NAME = '.attestbook-sandbox'

/**
 * Default base directory when no `SANDBOX_TEMP_DIR` is configured. The launcher
 * creates it on first use with mode `0700` and never changes the mode of a
 * pre-existing directory.
 */
export function defaultSandboxTempBase(): string {
  return join(tmpdir(), SANDBOX_TEMP_DIRECTORY_NAME)
}
