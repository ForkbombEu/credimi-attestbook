#!/usr/bin/env bash
# Starts the UAT server with the test-only administrator configuration created
# by `bun scripts/uat-setup.ts` (issue #88). Keeping the values in an ignored
# file under dist/ keeps them out of committed sources and out of the shell
# history of the sandbox.

set -euo pipefail

environment_file="dist/uat/admin.env"
if [[ ! -f "$environment_file" ]]; then
  echo "missing $environment_file; run mise run uat:setup first" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$environment_file"
set +a

exec bun dist/server.js
