/**
 * Getting the JSON to look at: from a URL, or from a file.
 *
 * The file path exists so the whole tool can be exercised - and tested - with no
 * network at all, and so a payload captured from a flaky endpoint can be checked
 * again later.
 */

import { readFileSync } from "node:fs";

export interface FetchOptions {
  headers: Record<string, string>;
  timeoutMs: number;
  /** Dotted path into the response, for APIs that wrap the payload: `data.items`. */
  pick?: string;
}

export function pickPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let current = value;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") {
      throw new Error(`--pick ${path}: nothing at "${segment}"`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export async function loadJson(source: string, options: FetchOptions): Promise<unknown> {
  const raw = /^https?:\/\//i.test(source)
    ? await get(source, options)
    : readFileSync(source, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${source} did not return JSON (first 80 chars: ${raw.slice(0, 80).trim()})`);
  }
  return pickPath(parsed, options.pick);
}

async function get(url: string, options: FetchOptions): Promise<string> {
  const response = await fetch(url, {
    headers: { accept: "application/json", ...options.headers },
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!response.ok) {
    // A 500 is not drift, it is an outage, and calling it drift would rewrite a
    // perfectly good baseline with an error page.
    throw new Error(`${url} answered ${response.status} ${response.statusText}`);
  }
  return response.text();
}

/** `Name: value` pairs from the command line into a header map. */
export function parseHeaders(pairs: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of pairs) {
    const index = pair.indexOf(":");
    if (index === -1) throw new Error(`--header wants "Name: value", got ${pair}`);
    headers[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return headers;
}
