// Test fixture: mimics Bun failing to write its temporary files at startup.
process.stderr.write('error: bun is unable to write files: AccessDenied\n')
process.exit(1)
