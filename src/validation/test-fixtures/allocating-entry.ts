// Test fixture: allocate until the parent RSS watchdog kills this child.
const chunks: number[][] = []
for (;;) {
  chunks.push(new Array<number>(1_000_000).fill(1))
}
