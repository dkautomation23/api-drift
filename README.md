# api-drift

[![CI](https://github.com/dkautomation23/api-drift/actions/workflows/ci.yml/badge.svg)](https://github.com/dkautomation23/api-drift/actions/workflows/ci.yml)

Records the **shape** of a JSON API and tells you when it changes — before the
automation reading it quietly starts writing rubbish.

```bash
api-drift record --name orders --source https://api.example.com/orders --pick data
api-drift check                 # exit 1 when something breaking changed
```

No runtime dependencies. TypeScript, Node's own test runner, 25 tests.

## Why

Integrations rarely break with an error. A partner renames `order_id` to
`orderId`, or starts sending `total` as a number instead of a string, and
nothing throws: the workflow keeps running, the field reads as `undefined`, and
two weeks later somebody notices that a fortnight of rows have an empty column.

Nobody watches for that, because watching means remembering what the response
used to look like. That is the whole job of this tool.

```console
$ api-drift check --name orders

orders
  info   $[].coupon  optional field absent: string
  BREAK  $[].customer.vat  type changed: string -> null
  new    $[].items[].warehouse  new field: string
  BREAK  $[].order_id  field removed: string
  BREAK  $[].total  type changed: string -> number
  new    $[].channel  new field: string
  new    $[].orderId  new field: string

3 breaking, 3 additive across 1 endpoint(s)
```

That run is reproducible — the two fixtures behind it are in `fixtures/`:

```bash
api-drift record --name orders --source fixtures/orders-v1.json --pick data --baseline /tmp/b.json
api-drift check  --name orders --source fixtures/orders-v2.json --pick data --baseline /tmp/b.json
```

Note what it did with the rename: `order_id` gone is **breaking**, `orderId`
arriving is **additive**, and the two lines next to each other are what a rename
actually looks like from the outside. No guessing, no fuzzy matching on names.

## What counts as breaking

Severity is judged from the point of view of code that already consumes the old
shape.

| Change | Severity | Because |
| --- | --- | --- |
| Field removed | **breaking** | every reader of it now gets `undefined` |
| Type changed (`string` → `number`) | **breaking** | arithmetic, comparison and formatting all shift under you |
| Became nullable (`string` → `string \| null`) | **breaking** | the `.trim()` that worked for a year is one response from a TypeError |
| Object where an array used to be | **breaking** | the loop stops iterating and says nothing |
| Required field became optional | **breaking** | it is absent *sometimes*, which is worse than always |
| New field | additive | it cannot break a consumer that does not know about it |
| Optional field absent this time | info | already recorded as optional; nothing changed |

`--strict` makes additive changes fail too, for a contract you own on both sides
and want frozen.

## Recording an honest baseline

A single response is a poor description of an endpoint: whatever happened to be
absent from that one payload becomes tomorrow's false alarm. Pass `--source`
more than once and the samples are folded into one shape, with anything that is
not always present recorded as optional:

```bash
api-drift record --name orders \
    --source https://api.example.com/orders?status=open \
    --source https://api.example.com/orders?status=refunded \
    --source https://api.example.com/orders?status=draft
```

The baseline is one JSON file, `api-drift.json` by default, with sorted keys —
**commit it**. Then the day the partner changes something, the pull request that
updates the baseline shows the change in review, next to the code that depends
on it.

## In cron, or in CI

`check` exits `1` on a breaking change and `0` otherwise, so it needs no wrapper:

```yaml
- run: npx api-drift check --header "Authorization: Bearer ${{ secrets.PARTNER_TOKEN }}"
```

An endpoint that is *down* is not drift: a non-2xx answer, or a body that is not
JSON, is reported as an error (exit `2`) rather than as a change — otherwise the
first maintenance page would overwrite a good baseline with the shape of an HTML
error document.

## Install

```bash
git clone https://github.com/dkautomation23/api-drift.git
cd api-drift
npm install
npm test          # 25 tests, no network beyond localhost
npm run build
node dist/src/cli.js --help
```

Node 22+. Auth goes in `--header`, repeatable, never into the baseline file.

| Flag | Meaning |
| --- | --- |
| `--name` | endpoint name in the baseline |
| `--source` | URL or a JSON file; repeatable on `record` |
| `--pick a.b` | look at this path inside the response |
| `--header "K: V"` | request header, repeatable |
| `--baseline PATH` | baseline file (default `api-drift.json`) |
| `--timeout MS` | per request, default 15000 |
| `--strict` | additive changes fail too |
| `--json` | machine-readable report |

## Honest limits

- **Shape, not values.** A field that changes from `"EUR"` to `"USD"` is not
  drift here. Enum tracking would need a notion of how many values are "all of
  them", and guessing that wrong is noisier than not guessing.
- **It reads what you point it at.** An endpoint that is paginated, or that
  returns a different shape per account, needs one baseline entry per case —
  that is what `--name` is for.
- **No authentication flows.** Tokens go in `--header`; refreshing them is the
  caller's job, and keeping that out means the tool never holds a credential.
- **JSON only.** XML and protobuf partners exist; they are not this tool.
- **A rename reads as a removal plus an addition**, deliberately. Pairing them
  up by similar names would be a guess, and a wrong guess here reads as "nothing
  broke".

## License

MIT
