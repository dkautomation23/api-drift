#!/usr/bin/env node
/**
 * api-drift - notice when a partner API changes shape, before it breaks you.
 */

import { empty, load, save, type Baseline } from "./baseline.js";
import { loadJson, parseHeaders, type FetchOptions } from "./source.js";
import { compare, describe, infer, merge, worst, type Change, type Shape } from "./schema.js";

const USAGE = `api-drift - notice when a partner API changes shape, before it breaks you.

  api-drift record  --name orders --source https://api.example.com/orders [--pick data]
  api-drift check   [--name orders] [--source URL_OR_FILE]
  api-drift show    [--name orders]

  --baseline PATH     baseline file (default api-drift.json), commit it
  --source URL|FILE   endpoint to read, or a saved JSON file
  --pick a.b          look at this path inside the response
  --header "K: V"     request header, repeatable (auth goes here)
  --timeout MS        default 15000
  --strict            treat new fields as a failure too
  --json              machine-readable output

check exits 1 when something breaking changed, 0 otherwise - so it belongs in
cron or in CI.
`;

interface Args {
  command: string;
  flags: Map<string, string>;
  many: Map<string, string[]>;
  bools: Set<string>;
}

function parse(argv: string[]): Args {
  const flags = new Map<string, string>();
  const many = new Map<string, string[]>();
  const bools = new Set<string>();

  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      bools.add(name);
    } else {
      flags.set(name, next);
      many.set(name, [...(many.get(name) ?? []), next]);
      i += 1;
    }
  }
  return { command: argv[0] ?? "", flags, many, bools };
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const MARK: Record<string, string> = { breaking: "BREAK", additive: "new  ", info: "info " };

function print(name: string, changes: Change[]): void {
  process.stdout.write(`\n${name}\n`);
  if (changes.length === 0) {
    process.stdout.write("  unchanged\n");
    return;
  }
  for (const change of changes) {
    const detail =
      change.before && change.after
        ? `${change.before} -> ${change.after}`
        : (change.after ?? change.before ?? "");
    process.stdout.write(`  ${MARK[change.severity]}  ${change.path}  ${change.what}${detail ? `: ${detail}` : ""}\n`);
  }
}

function fetchOptions(args: Args): FetchOptions {
  return {
    headers: parseHeaders(args.many.get("header") ?? []),
    timeoutMs: Number(args.flags.get("timeout") ?? 15_000),
    pick: args.flags.get("pick"),
  };
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  if (!args.command || args.command === "help" || args.bools.has("help")) {
    process.stdout.write(USAGE);
    return args.command ? 0 : 2;
  }

  const path = args.flags.get("baseline") ?? "api-drift.json";
  const baseline: Baseline = args.command === "record" && !args.bools.has("append") ? load(path) : load(path);

  if (args.command === "record") {
    const name = args.flags.get("name") ?? fail("record needs --name");
    const source = args.flags.get("source") ?? fail("record needs --source");
    const sources = args.many.get("source") ?? [source];

    // Several samples fold into one shape, which is how a field that is only
    // sometimes present gets recorded as optional instead of as tomorrow's
    // false alarm.
    let shape: Shape | null = null;
    for (const one of sources) {
      const observed = infer(await loadJson(one, fetchOptions(args)));
      shape = shape ? merge(shape, observed) : observed;
    }

    baseline.entries[name] = {
      name,
      url: /^https?:/i.test(source) ? source : undefined,
      recordedAt: new Date().toISOString(),
      samples: sources.length,
      shape: shape!,
    };
    save(path, baseline);
    process.stdout.write(`recorded ${name} from ${sources.length} sample(s) -> ${path}\n  ${describe(shape!)}\n`);
    return 0;
  }

  if (args.command === "show") {
    const only = args.flags.get("name");
    const entries = Object.values(baseline.entries).filter((entry) => !only || entry.name === only);
    if (entries.length === 0) fail(`nothing recorded in ${path}`);
    for (const entry of entries) {
      process.stdout.write(
        `${entry.name}  (${entry.samples} sample(s), ${entry.recordedAt})\n  ${entry.url ?? "file"}\n  ${describe(entry.shape)}\n\n`,
      );
    }
    return 0;
  }

  if (args.command === "check") {
    const only = args.flags.get("name");
    const override = args.flags.get("source");
    const entries = Object.values(baseline.entries).filter((entry) => !only || entry.name === only);
    if (entries.length === 0) fail(`nothing to check in ${path}`);

    const report: Record<string, Change[]> = {};
    let breaking = 0;
    let additive = 0;

    for (const entry of entries) {
      const source = override ?? entry.url;
      if (!source) {
        process.stderr.write(`${entry.name}: recorded from a file, pass --source to check it\n`);
        continue;
      }
      const changes = compare(entry.shape, infer(await loadJson(source, fetchOptions(args))));
      report[entry.name] = changes;
      if (!args.bools.has("json")) print(entry.name, changes);
      breaking += changes.filter((change) => change.severity === "breaking").length;
      additive += changes.filter((change) => change.severity === "additive").length;
    }

    if (args.bools.has("json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`\n${breaking} breaking, ${additive} additive across ${entries.length} endpoint(s)\n`);
    }

    if (breaking > 0) return 1;
    if (additive > 0 && args.bools.has("strict")) return 1;
    return 0;
  }

  fail(`unknown command ${args.command}\n\n${USAGE}`);
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  },
);

export { empty, worst };
