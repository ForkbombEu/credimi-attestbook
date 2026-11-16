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

# Test-only: a local UAT scenario may point a webhook callback at a disposable
# loopback HTTP server so it can observe the verification handshake. This is
# the explicitly configured test-loopback opt-in; a DNS name still may never
# resolve to a non-public address and production keeps the flag off.
export SUBSCRIPTIONS_ALLOW_LOOPBACK_HTTP=1

# Run the application under the test-only supervisor so a local UAT can restart
# it through `POST http://127.0.0.1:3001/restart` and observe restart
# persistence. The supervisor forwards the application's output and keeps the
# application on its normal port; it binds loopback only and is never used by
# the production image.
exec bun scripts/uat-supervisor.ts
