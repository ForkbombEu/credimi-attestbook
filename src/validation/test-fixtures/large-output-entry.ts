// Test fixture: exceed the sandbox output cap.
process.stdout.write('x'.repeat(2 * 1024 * 1024))
