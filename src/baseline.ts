/**
 * Where the recorded shapes live.
 *
 * One JSON file, one entry per watched endpoint, meant to be committed. That is
 * the point: the diff in a pull request then says "this partner's API changed",
 * in review, in the same place as the code that depends on it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Shape } from "./schema.js";

export interface Entry {
  name: string;
  url?: string;
  recordedAt: string;
  samples: number;
  shape: Shape;
}

export interface Baseline {
  version: 1;
  entries: Record<string, Entry>;
}

export function empty(): Baseline {
  return { version: 1, entries: {} };
}

export function load(path: string): Baseline {
  if (!existsSync(path)) return empty();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Baseline;
  if (parsed.version !== 1 || typeof parsed.entries !== "object") {
    throw new Error(`${path} is not an api-drift baseline`);
  }
  return parsed;
}

export function save(path: string, baseline: Baseline): void {
  mkdirSync(dirname(path) || ".", { recursive: true });
  // Sorted keys and a trailing newline: a baseline is read as a diff far more
  // often than it is read on its own.
  const entries = Object.fromEntries(
    Object.keys(baseline.entries).sort().map((key) => [key, baseline.entries[key]!]),
  );
  writeFileSync(path, `${JSON.stringify({ ...baseline, entries }, null, 2)}\n`, "utf8");
}
