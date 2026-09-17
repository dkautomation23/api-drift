import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe as suite, it } from "node:test";

import { compare, describe, infer, merge, worst, type Change } from "../src/schema.js";
import { empty, load, save } from "../src/baseline.js";
import { loadJson, parseHeaders, pickPath } from "../src/source.js";

const work = mkdtempSync(join(tmpdir(), "api-drift-"));
after(() => rmSync(work, { recursive: true, force: true }));

function changesFor(before: unknown, after: unknown): Change[] {
  return compare(infer(before), infer(after));
}
function at(changes: Change[], path: string): Change | undefined {
  return changes.find((change) => change.path === path);
}

suite("inferring a shape", () => {
  it("reads the types, not the values", () => {
    const a = infer({ id: "1", total: 10, paid: true, note: null });
    const b = infer({ id: "2", total: 99, paid: false, note: null });
    assert.deepEqual(a, b, "two different orders have the same shape");
  });

  it("folds every element of a list, not just the first", () => {
    const shape = infer([{ id: 1 }, { id: 2, coupon: "X" }]);
    assert.equal(shape.kind, "array");
    const element = shape.kind === "array" ? shape.element : null;
    assert.ok(element && element.kind === "object");
    assert.equal(element.fields.coupon?.optional, true, "seen in one item only");
    assert.equal(element.fields.id?.optional, false);
  });

  it("an empty list claims nothing about its elements", () => {
    assert.deepEqual(infer([]), { kind: "array", element: null });
    assert.deepEqual(changesFor([], [{ id: 1 }]), [], "an empty baseline cannot drift");
  });

  it("merging samples makes a sometimes-present field optional", () => {
    const merged = merge(infer({ id: 1, refundedAt: "…" }), infer({ id: 2 }));
    assert.ok(merged.kind === "object");
    assert.equal(merged.fields.refundedAt?.optional, true);
    assert.equal(merged.fields.id?.optional, false);
  });

  it("prints a shape a human can read", () => {
    assert.equal(describe(infer({ b: 1, a: "x" })), "{ a, b }");
    assert.equal(describe(infer([1, 2])), "number[]");
    assert.equal(describe(infer(null)), "null");
  });
});

suite("what counts as breaking", () => {
  it("a removed field is breaking", () => {
    const changes = changesFor({ id: 1, email: "a@b.c" }, { id: 1 });
    assert.equal(at(changes, "$.email")?.severity, "breaking");
    assert.equal(at(changes, "$.email")?.what, "field removed");
  });

  it("a changed type is breaking, and says which way", () => {
    const change = at(changesFor({ id: "1" }, { id: 1 }), "$.id");
    assert.equal(change?.severity, "breaking");
    assert.equal(change?.before, "string");
    assert.equal(change?.after, "number");
  });

  it("a field that can now be null is breaking", () => {
    // Still a string in most rows, null in some: the reader that has been doing
    // `name.trim()` for a year is one response away from a TypeError.
    const after = merge(infer({ name: "Acme" }), infer({ name: null }));
    const change = at(compare(infer({ name: "Acme" }), after), "$.name");
    assert.equal(change?.severity, "breaking");
    assert.equal(change?.what, "became nullable");
    assert.equal(change?.after, "null | string");
  });

  it("a field that is now always null is a type change, not merely nullable", () => {
    const change = at(changesFor({ name: "Acme" }, { name: null }), "$.name");
    assert.equal(change?.severity, "breaking");
    assert.equal(change?.what, "type changed");
  });

  it("an object where a list used to be is breaking", () => {
    assert.equal(at(changesFor({ items: [] }, { items: {} }), "$.items")?.severity, "breaking");
  });

  it("a new field is additive, not breaking", () => {
    const changes = changesFor({ id: 1 }, { id: 1, currency: "EUR" });
    assert.equal(at(changes, "$.currency")?.severity, "additive");
    assert.equal(worst(changes), "additive");
  });

  it("an optional field that happens to be absent is only information", () => {
    const before = merge(infer({ id: 1, coupon: "X" }), infer({ id: 1 }));
    const changes = compare(before, infer({ id: 1 }));
    assert.equal(at(changes, "$.coupon")?.severity, "info");
  });

  it("identical payloads produce nothing at all", () => {
    assert.deepEqual(changesFor({ a: [{ b: 1 }] }, { a: [{ b: 2 }] }), []);
    assert.equal(worst([]), null);
  });

  it("looks inside arrays and reports the path with []", () => {
    const changes = changesFor({ items: [{ sku: "A" }] }, { items: [{ sku: 1 }] });
    assert.equal(at(changes, "$.items[].sku")?.severity, "breaking");
  });

  it("finds a change nested several levels down", () => {
    const changes = changesFor(
      { order: { customer: { address: { zip: "10115" } } } },
      { order: { customer: { address: { zip: 10115 } } } },
    );
    assert.equal(at(changes, "$.order.customer.address.zip")?.severity, "breaking");
  });

  it("the real case this exists for: a rename reads as both halves", () => {
    const changes = changesFor({ order_id: 1 }, { orderId: 1 });
    assert.equal(at(changes, "$.order_id")?.severity, "breaking");
    assert.equal(at(changes, "$.orderId")?.severity, "additive");
  });
});

suite("the baseline file", () => {
  it("round-trips and sorts its entries", () => {
    const path = join(work, "baseline.json");
    const baseline = empty();
    baseline.entries.zeta = { name: "zeta", recordedAt: "now", samples: 1, shape: infer({ a: 1 }) };
    baseline.entries.alpha = { name: "alpha", recordedAt: "now", samples: 2, shape: infer([1]) };
    save(path, baseline);

    const reloaded = load(path);
    assert.deepEqual(Object.keys(reloaded.entries), ["alpha", "zeta"]);
    assert.deepEqual(reloaded.entries.zeta?.shape, infer({ a: 1 }));
  });

  it("a missing file is an empty baseline, not an error", () => {
    assert.deepEqual(load(join(work, "absent.json")), empty());
  });

  it("refuses a file that is not a baseline", () => {
    const path = join(work, "foreign.json");
    writeFileSync(path, '{"hello":"world"}', "utf8");
    assert.throws(() => load(path), /not an api-drift baseline/);
  });
});

suite("reading the source", () => {
  it("picks a path inside a wrapped response", () => {
    assert.deepEqual(pickPath({ data: { items: [1] } }, "data.items"), [1]);
    assert.deepEqual(pickPath({ a: 1 }, undefined), { a: 1 });
    assert.throws(() => pickPath({ a: 1 }, "a.b.c"), /nothing at/);
  });

  it("parses headers and rejects a malformed one", () => {
    assert.deepEqual(parseHeaders(["Authorization: Bearer x", "X-A:1"]), {
      Authorization: "Bearer x",
      "X-A": "1",
    });
    assert.throws(() => parseHeaders(["nope"]), /Name: value/);
  });

  it("reads a file as happily as a URL", async () => {
    const path = join(work, "fixture.json");
    writeFileSync(path, '{"id":1}', "utf8");
    assert.deepEqual(await loadJson(path, { headers: {}, timeoutMs: 1000 }), { id: 1 });
  });

  it("reads a live endpoint and sends the headers it was given", async () => {
    let seenAuth = "";
    const server = createServer((request, response) => {
      seenAuth = String(request.headers.authorization ?? "");
      response.writeHead(200, { "content-type": "application/json" }).end('{"data":{"id":"1"}}');
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const value = await loadJson(`http://localhost:${port}/orders`, {
      headers: { Authorization: "Bearer test" },
      timeoutMs: 2000,
      pick: "data",
    });
    server.close();

    assert.deepEqual(value, { id: "1" });
    assert.equal(seenAuth, "Bearer test");
  });

  it("an outage is an error, not a drift report", async () => {
    const server = createServer((_request, response) => response.writeHead(503).end("down"));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    await assert.rejects(
      loadJson(`http://localhost:${port}/orders`, { headers: {}, timeoutMs: 2000 }),
      /answered 503/,
    );
    server.close();
  });

  it("an HTML error page is reported as not-JSON, not parsed", async () => {
    const server = createServer((_request, response) =>
      response.writeHead(200, { "content-type": "text/html" }).end("<html>maintenance</html>"),
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    await assert.rejects(
      loadJson(`http://localhost:${port}/orders`, { headers: {}, timeoutMs: 2000 }),
      /did not return JSON/,
    );
    server.close();
  });
});
