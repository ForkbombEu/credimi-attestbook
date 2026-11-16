// Test fixture: reports the environment the launcher gave this child, so a test
// can assert the exact allowlist without relying on child behaviour.
process.stdout.write(JSON.stringify({ env: process.env }))
