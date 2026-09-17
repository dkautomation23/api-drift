/**
 * Describing the *shape* of a JSON response, and saying what changed between
 * two shapes.
 *
 * The shape, not the data. A partner API that returns a different order id on
 * every call has not changed; one that starts returning that id as a number
 * instead of a string has, and that is the change which quietly breaks an
 * automation three days later.
 */

export type Scalar = "string" | "number" | "boolean" | "null";

export type Shape =
  | { kind: "scalar"; types: Scalar[] }
  | { kind: "array"; element: Shape | null }
  | { kind: "object"; fields: Record<string, Field> };

export interface Field {
  shape: Shape;
  /** Missing from at least one observed object at this path. */
  optional: boolean;
}

function scalarOf(value: unknown): Scalar {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  return "number";
}

export function infer(value: unknown): Shape {
  if (Array.isArray(value)) {
    // Every element folded into one shape: a list whose items disagree is
    // exactly the thing worth knowing about, and reading only the first item
    // is how a checker misses it.
    let element: Shape | null = null;
    for (const item of value) element = element ? merge(element, infer(item)) : infer(item);
    return { kind: "array", element };
  }

  if (value !== null && typeof value === "object") {
    const fields: Record<string, Field> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      fields[key] = { shape: infer(item), optional: false };
    }
    return { kind: "object", fields };
  }

  return { kind: "scalar", types: [scalarOf(value)] };
}

/** The union of two shapes: what a value at this path is allowed to look like. */
export function merge(a: Shape, b: Shape): Shape {
  if (a.kind === "scalar" && b.kind === "scalar") {
    return { kind: "scalar", types: [...new Set([...a.types, ...b.types])].sort() };
  }
  if (a.kind === "array" && b.kind === "array") {
    const element = a.element && b.element ? merge(a.element, b.element) : (a.element ?? b.element);
    return { kind: "array", element };
  }
  if (a.kind === "object" && b.kind === "object") {
    const fields: Record<string, Field> = {};
    for (const key of new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])) {
      const left = a.fields[key];
      const right = b.fields[key];
      if (left && right) {
        fields[key] = { shape: merge(left.shape, right.shape), optional: left.optional || right.optional };
      } else {
        // Present in one and not the other: optional from here on.
        fields[key] = { shape: (left ?? right)!.shape, optional: true };
      }
    }
    return { kind: "object", fields };
  }
  // Genuinely different kinds (object where an array used to be): keep both as
  // a scalar union so the comparison reports a type change rather than crashing.
  return { kind: "scalar", types: [...new Set([describe(a), describe(b)] as Scalar[])].sort() };
}

export function describe(shape: Shape): string {
  switch (shape.kind) {
    case "scalar":
      return shape.types.join(" | ");
    case "array":
      return shape.element ? `${describe(shape.element)}[]` : "unknown[]";
    case "object":
      return `{ ${Object.keys(shape.fields).sort().join(", ")} }`;
  }
}

export type Severity = "breaking" | "additive" | "info";

export interface Change {
  path: string;
  severity: Severity;
  what: string;
  before?: string;
  after?: string;
}

/**
 * What changed going from `before` to `after`.
 *
 * Severity is decided from the point of view of code that already consumes the
 * old shape: anything that can make a working integration read `undefined`, or
 * hand the wrong type to something downstream, is breaking. A new field cannot
 * break a consumer that does not know about it, so it is additive - loud enough
 * to notice, not loud enough to page anyone.
 */
export function compare(before: Shape, after: Shape, path = "$"): Change[] {
  if (before.kind !== after.kind) {
    return [{
      path,
      severity: "breaking",
      what: "type changed",
      before: describe(before),
      after: describe(after),
    }];
  }

  if (before.kind === "scalar" && after.kind === "scalar") {
    const gone = before.types.filter((type) => !after.types.includes(type) && type !== "null");
    const gained = after.types.filter((type) => !before.types.includes(type));

    const changes: Change[] = [];
    if (gone.length > 0 || gained.some((type) => type !== "null")) {
      changes.push({
        path,
        severity: "breaking",
        what: "type changed",
        before: describe(before),
        after: describe(after),
      });
    } else if (gained.includes("null")) {
      // Same type, but it can now be null. Every `response.x.y` on this path is
      // one bad day away from a TypeError.
      changes.push({
        path,
        severity: "breaking",
        what: "became nullable",
        before: describe(before),
        after: describe(after),
      });
    }
    return changes;
  }

  if (before.kind === "array" && after.kind === "array") {
    if (!before.element || !after.element) return []; // an empty list says nothing
    return compare(before.element, after.element, `${path}[]`);
  }

  if (before.kind === "object" && after.kind === "object") {
    const changes: Change[] = [];
    for (const key of Object.keys(before.fields).sort()) {
      const left = before.fields[key]!;
      const right = after.fields[key];
      const at = `${path}.${key}`;

      if (!right) {
        changes.push({
          path: at,
          severity: left.optional ? "info" : "breaking",
          what: left.optional ? "optional field absent" : "field removed",
          before: describe(left.shape),
        });
        continue;
      }
      if (!left.optional && right.optional) {
        changes.push({ path: at, severity: "breaking", what: "became optional", before: describe(left.shape) });
      }
      changes.push(...compare(left.shape, right.shape, at));
    }
    for (const key of Object.keys(after.fields).sort()) {
      if (!before.fields[key]) {
        changes.push({
          path: `${path}.${key}`,
          severity: "additive",
          what: "new field",
          after: describe(after.fields[key]!.shape),
        });
      }
    }
    return changes;
  }

  return [];
}

export function worst(changes: Change[]): Severity | null {
  if (changes.some((change) => change.severity === "breaking")) return "breaking";
  if (changes.some((change) => change.severity === "additive")) return "additive";
  return changes.length > 0 ? "info" : null;
}
