# Contributing

## Setup

    npm ci

Node.js 22 or later (see `engines` in package.json; CI runs 22.x and 24.x).

## Build

    npm run build

Runs `tsc`, compiling `src/**/*.ts` and `test/**/*.ts` (see tsconfig.json)
to `dist/`.

## Test

    npm test

Runs `npm run build` and then `node --test "dist/test/**/*.test.js"` — the
compiled tests, via Node's own test runner. There is no separate lint or
format command; `tsc --strict` is what catches type errors.

## What CI checks

`.github/workflows/ci.yml` runs on every push to `main` and on every pull
request, on a Node.js 22.x / 24.x matrix:

    npm ci
    npm run build
    node --test "dist/test/**/*.test.js"

A pull request has to pass on both Node versions.

## Adding a new check

A check here is a comparison rule in `compare()` (`src/schema.ts`) that
classifies a change to a recorded shape as `breaking`, `additive`, or
`info`. Add the failing case to `test/unit.test.ts` first — two shapes and
the `Change` you expect `compare()` to produce between them — then make it
pass.

## Commit messages

One line, sentence case, no trailing period, says what the commit does for
the tool rather than how it does it — for example, from this repo's own
history:

    Answer --help with the usage text
    Exit without crashing on Windows
    CI: test on Node 22 and 24, and require 22 in engines

## Scope

`dist/` is build output, not source — don't edit it or include it in a diff.
