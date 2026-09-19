# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

- GitHub: use "Report a vulnerability" under this repository's Security tab
  (Private vulnerability reporting) —
  https://github.com/dkautomation23/api-drift/security/advisories/new
- Email: hello@dkautomation.dev

Include what you ran, what you expected, what happened instead, and the
smallest baseline/response that reproduces it.

We aim to send a first response within 3 business days.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x (latest release) | yes |
| anything older | no |

api-drift has not reached 1.0. Only the latest published release is
supported — update before reporting.

## Scope

api-drift records the *shape* of a JSON response — field names and types,
in `src/schema.ts` — into a baseline file that is meant to be committed and
read in pull requests. Two things matter here: that only the shape, never
response data, ends up in that committed file, and that a credential passed
on the command line never ends up there either.

In scope:

- Any path that writes a value from `--header` into the saved baseline.
  Credentials belong in `--header` (the `--help` text says so) precisely
  because headers are request-only and are never part of an `Entry` in
  `src/baseline.ts` today — a change that breaks that is in scope.
- A way to make `record` or `check` write outside the file named by
  `--baseline`.
- A crafted API response that makes `compare()` (`src/schema.ts`)
  misclassify a breaking change as additive/info, or the reverse, in a way
  that contradicts the rules documented next to `compare()`.

Out of scope:

- A credential placed in the `--source` URL's query string instead of in a
  `--header`. The source URL is stored in the baseline on purpose, so
  `check` knows what to hit again — that is documented behavior, not a bug.
  Use `--header` for anything secret.
- The target API's own availability, correctness, or security.
- `--baseline` reading or writing whatever local path you name — your own
  command line.
