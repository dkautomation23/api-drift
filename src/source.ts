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

/** A shape is kilobytes of JSON; anything past this is not one. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Follows redirects by hand, and takes the credentials off at the border.
 *
 * `--header "Authorization: ..."` is documented as where auth goes. Letting
 * fetch follow a redirect with those headers attached means a partner's 302 -
 * or an attacker who can influence one - receives the operator's API key. The
 * key is for the host the operator named, and nobody else.
 */
async function get(url: string, options: FetchOptions): Promise<string> {
  let current = url;
  const origin = new URL(url).origin;
  let response: Response | undefined;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const sameOrigin = new URL(current).origin === origin;
    response = await fetch(current, {
      headers: sameOrigin
        ? { accept: "application/json", ...options.headers }
        : { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
    });

    if (!REDIRECT_STATUS.has(response.status)) break;
    const location = response.headers.get("location");
    if (!location) break;
    await response.body?.cancel();
    current = new URL(location, current).toString();
    response = undefined;
  }

  if (!response) {
    throw new Error(`${url} sent more than ${MAX_REDIRECTS} redirects; giving up`);
  }
  if (!response.ok) {
    // A 500 is not drift, it is an outage, and calling it drift would rewrite a
    // perfectly good baseline with an error page.
    throw new Error(`${url} answered ${response.status} ${response.statusText}`);
  }

  return readCapped(response, MAX_RESPONSE_BYTES, url);
}

/**
 * Reads at most `limit` bytes.
 *
 * `response.text()` buffers whatever arrives before any check can run, so an
 * endpoint that never stops talking costs the machine its memory rather than
 * the caller a clear error.
 */
async function readCapped(response: Response, limit: number, url: string): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error(`${url} returned more than ${limit} bytes; that is too large to be a response shape`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  return text + decoder.decode();
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
