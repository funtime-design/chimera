// pnpm test runs the owner-mode suite against a running bridge at GOONBRIDGE_URL with the owner's fixtures. Without
// GOONBRIDGE_URL it would fail test by test, so it stops here with the one line that says what to run instead.
if (!process.env.GOONBRIDGE_URL) {
  console.error('owner mode needs GOONBRIDGE_URL and fixtures; run `pnpm test:engine` for the self-contained suite');
  process.exit(1);
}
