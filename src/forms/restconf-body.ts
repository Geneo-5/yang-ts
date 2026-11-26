/**
 * §195 — Inverse RESTCONF bridge: form values to RFC 7951 JSON bodies and
 * form paths to `YangPathSegment` paths for the existing request builders.
 *
 * The leaf encoding mirrors `documentToYangJson` exactly (32-bit integers as
 * JSON numbers, int64/uint64/decimal64 as strings, `empty` as `[null]`, bits
 * space-separated, identityref/instance-identifier passed through) so a body
 * built from form values round-trips through `yangJsonToDocument` /
 * `documentToYangJson` without surprises; the round trip is asserted in
 * `tests/forms-restconf.test.ts`.
 *
 * Values contract (see also the form model's known §87 limitations — the form
 * model is parse-tree based, so this bridge covers the fields it models):
 * - leaf: one value (whatever the control produced);
 * - leaf-list (`field.multiple`, incl. `bits` selected as an array): an array;
 * - list: at the `[*]`-suffixed list path, an ARRAY of entry records, each
 *   record mapping the full child field paths to their values — entries keep
 *   the array order and every child lookup runs on the record itself.
 */
import type { FormField, FormModel, FormRpcOperation } from "./form-model.js";
import type { YangPathKey, YangPathSegment } from "../restconf/paths.js";

/** Same membership as the number set in src/restconf/yang-json.ts. */
const NUMBER_TYPES: ReadonlySet<string> = new Set(["int8", "int16", "int32", "uint8", "uint16", "uint32"]);

/** One values map: full field paths to values (or list paths to entry-record arrays). */
export type FormValues = Readonly<Record<string, unknown>>;

/** Encode one leaf value with the engine's RFC 7951 conventions. */
function encodeLeaf(field: FormField, value: unknown): unknown {
  const single = (input: unknown): unknown => {
    if (field.yangType === "empty") return [null];
    if (field.yangType === "bits") {
      // Engine convention (matching documentToYangJson): space-separated names.
      const names = Array.isArray(input) ? input.map(item => String(item)) : String(input).split(/\s+/);
      return names.filter(Boolean).join(" ");
    }
    if (typeof input !== "string" && typeof input !== "number" && typeof input !== "boolean") return undefined;
    if (field.yangType === "boolean") {
      if (input === "true" || input === true) return true;
      if (input === "false" || input === false) return false;
      return String(input);
    }
    if (NUMBER_TYPES.has(field.yangType)) {
      const number = typeof input === "number" ? input : Number(input);
      return Number.isNaN(number) ? String(input) : number;
    }
    // string, enumeration, binary, identityref, instance-identifier,
    // int64/uint64/decimal64 and unresolved types keep the text form.
    return String(input);
  };
  if (field.multiple) {
    if (value === undefined) return undefined;
    const list = Array.isArray(value) ? value : [value];
    return list.map(single);
  }
  return single(value);
}

interface Step {
  name: string;
  list: boolean;
}

const stepsOf = (relative: string): Step[] =>
  relative
    .split("/")
    .filter(Boolean)
    .map(part => ({ name: part.endsWith("[*]") ? part.slice(0, -3) : part, list: part.endsWith("[*]") }));

/**
 * Build one RFC 7951 object from form fields whose paths start with `prefix`
 * (which always ends with "/" and starts with "/"). `values` maps FULL field
 * paths to leaf values; list step values live at `/<…>/list[*]` as arrays of
 * entry records keyed by full child field paths.
 */
function buildBody(fields: readonly FormField[], values: FormValues, prefix: string): Record<string, unknown> {
  const scoped = fields.filter(field => field.path.startsWith(prefix));
  const output: Record<string, unknown> = {};
  const containers = new Map<string, FormField[]>();
  for (const field of scoped) {
    const relative = field.path.slice(prefix.length);
    const local = stepsOf(relative);
    if (local.length === 0) continue;
    // 1. Lists: the entries array lives at `/<prefix><list>[*]` in `values`.
    if (local[0]!.list) {
      const marker = relative.indexOf("[*]");
      const listPath = `${prefix.slice(0, -1)}/${relative.slice(0, marker + 3)}`;
      const rawEntries = values[listPath];
      if (rawEntries === undefined) continue; // nothing submitted for this list
      if (!Array.isArray(rawEntries)) {
        throw new Error(`List value for '${listPath}' must be an array of entry records`);
      }
      // The list field itself is never modeled (keys are): model children only.
      if (local.length === 1) continue;
      const childPrefix = `${prefix.slice(0, -1)}/${relative.slice(0, marker + 3)}/`;
      output[local[0]!.name] = rawEntries.map(entry => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new Error(`List entry for '${listPath}' must be a record of child field values`);
        }
        return buildBody(scoped, entry as FormValues, childPrefix);
      });
      continue;
    }
    // 2. Direct leaves of this level (absent values are omitted entirely).
    if (local.length === 1) {
      const raw = values[field.path];
      if (raw === undefined) continue;
      const encoded = encodeLeaf(field, raw);
      if (encoded !== undefined) output[local[0]!.name] = encoded;
      continue;
    }
    // 3. Nested containers (bare names): group and recurse.
    const containerName = local[0]!.name;
    const grouped = containers.get(containerName) ?? [];
    grouped.push(field);
    containers.set(containerName, grouped);
  }
  for (const [name, grouped] of containers) {
    output[name] = buildBody(grouped, values, `${prefix}${name}/`);
  }
  return output;
}

/**
 * Build the RFC 7951 body for the form's top-level data resource:
 * `{ "module:top": { … } }`, the wrapper RESTCONF data requests expect for a
 * top-level resource. Values absent from the map are simply omitted.
 */
export function formValuesToRestconfBody(model: FormModel, values: FormValues): Record<string, unknown> {
  const dataFields = model.fields.filter(field => field.scope === "data");
  if (dataFields.length === 0) return {};
  const topLevel = new Map<string, FormField[]>();
  for (const field of dataFields) {
    const first = stepsOf(field.path)[0]?.name;
    if (!first) continue;
    const grouped = topLevel.get(first) ?? [];
    grouped.push(field);
    topLevel.set(first, grouped);
  }
  const body: Record<string, unknown> = {};
  for (const [name, fields] of topLevel) {
    // §87: with a compiled multi-module schema the model carries `topModules`
    // (top-node → module); a single-module model qualifies with its own name.
    const qualifier = model.topModules?.[name] ?? model.module;
    // A top-level leaf/leaf-list IS the data resource (RFC 8040 §3.5): encode
    // its own value — there are no children to recurse into (absent omitted).
    const selfLeaf = fields.find(field => field.path === `/${name}`);
    if (selfLeaf) {
      const raw = values[selfLeaf.path];
      if (raw !== undefined) {
        const encoded = encodeLeaf(selfLeaf, raw);
        if (encoded !== undefined) body[`${qualifier}:${name}`] = encoded;
      }
      continue;
    }
    body[`${qualifier}:${name}`] = buildBody(fields, values, `/${name}/`);
  }
  return body;
}

/**
 * Build the RFC 7951 input object for one RPC operation (without the
 * `module:input` wrapper — `createRestconfRpcRequest` adds it).
 */
export function formInputToRestconfBody(operation: FormRpcOperation, values: FormValues): Record<string, unknown> {
  return buildBody(operation.inputFields, values, `/${operation.name}/input/`);
}

/** Options for `formPathToYangPathSegments`. */
export interface FormPathOptions {
  /**
   * Key records for the `[*]` list steps along the path, in path order; each
   * record's entries become one segment's `keys` — pass them in the key
   * statement order, RESTCONF joins key values positionally.
   */
  listKeys?: readonly (Readonly<Record<string, string>>)[];
  /** Value that selects one `leaf-list` instance (applies to the last step). */
  leafListValue?: string;
}

/**
 * Map a form path (`/top/items[*]/v`, the `FormField.path` shape) to
 * `YangPathSegment[]` for the RESTCONF request builders; every step is
 * module-qualified with the given module (form models are single-module).
 */
export function formPathToYangPathSegments(
  path: string,
  module: string,
  options: FormPathOptions = {},
): readonly YangPathSegment[] {
  const steps = stepsOf(path);
  const listKeys = options.listKeys ?? [];
  let keyIndex = 0;
  const segments: YangPathSegment[] = steps.map((step, index) => {
    const segment: YangPathSegment = { name: step.name, module };
    if (step.list) {
      const keys = listKeys[keyIndex];
      if (keys === undefined) {
        throw new Error(
          `List '${step.name}' (step ${index + 1} of '${path}') has no key record: pass one 'listKeys' record per '[*]' step`,
        );
      }
      keyIndex++;
      const resolved = Object.entries(keys).map(([name, value]): YangPathKey => ({ name, value }));
      if (resolved.length === 0) {
        throw new Error(`List '${step.name}' has no key values`);
      }
      segment.keys = resolved;
    }
    if (options.leafListValue !== undefined && index === steps.length - 1 && !step.list) {
      segment.leafListValue = options.leafListValue;
    }
    return segment;
  });
  return segments;
}
