# Contributing

Issues and pull requests are welcome. The full guidance lives in the README's
[Contributing section](README.md#contributing); the short version:

- **`npm test` must pass.** It needs no install step, so there is no excuse.
- **No dependencies, ever** — not runtime, not development, not a linter or a test
  framework. This reads a bank account, and every dependency is code a user would have to
  trust without reading. That constraint is why the project can ask people to read it
  instead of trusting it.
- **Reporting a breakage?** Run `spike/snippet.js` in the DevTools console on a logged-in
  `app.revolut.com` tab and include what it printed. That distinguishes a change in
  Revolut's API from a bug here, and it is the single most useful thing to include.

Security issues go to [SECURITY.md](SECURITY.md), not a public issue.
