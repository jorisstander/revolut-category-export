# Security policy

This extension reads a bank account. If you find a way it could leak data, execute
untrusted content, or produce a wrong export that looks correct, please report it.

## Reporting

Open a [private security advisory](../../security/advisories/new) on this repository.
If you cannot, open a normal issue with only enough detail to make contact — not the
exploit — and I will follow up.

Please allow a reasonable window for a fix before disclosing publicly. There is no bounty;
this is a personal project.

## What is in scope

- Any path by which data reaches a host other than `app.revolut.com`.
- Anything that writes a file a spreadsheet would execute, or that escapes the intended
  download directory.
- An export that is silently wrong: missing rows, rows belonging to a different account,
  or incorrect amounts, without an error being raised. Silent wrongness is the failure
  mode this project cares most about, because the output is trusted and reconciled
  against.
- Anything that reads a cookie other than `revo_device_id`, or that stores data anywhere.

## What is out of scope

- Revolut's own API. This project only consumes it, and it is undocumented and may change
  without notice. Breakage is expected; report it as a normal bug.
- The `cookies` and `downloads` permissions themselves. Both are declared, used, and
  explained in the README.
- Anything requiring an attacker who already controls the browser profile or the machine.

## Design notes relevant to review

- One network call site in the extension, `src/core/http.js`, method `'GET'`, origin
  hard-coded. (`spike/snippet.js` also fetches, but it is a DevTools diagnostic you paste
  in yourself; the extension never loads it.)
- No storage APIs, no `eval`, no remote code, no dependencies — runtime or development.
- Untrusted text reaches the CSV; `src/core/serialize.js` neutralises formula-leading
  cells, and `src/core/pipeline.js` sanitises the download filename.
