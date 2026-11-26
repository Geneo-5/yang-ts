/**
 * §212 — binding API on top of the rebuilt form model (§87): which fields a
 * bound UI should show for the currently selected choice cases, and which
 * values are required right now; plus list-entry targeting that mirrors the
 * `formValuesToRestconfBody` contract (an entry record at the `[*]` list path
 * keyed by full child field paths).
 */
import type { FormField, FormModel } from "./form-model.js";
import type { FormValues } from "./restconf-body.js";

/** Selected active case per choice schema path (RFC 7950 §7.9); `undefined`/absent/"" = nothing active. */
export type ActiveCases = ReadonlyMap<string, string | undefined>;

/** The choice registry of the model, per choice path (for the loud checks). */
function choicesOf(model: FormModel): Map<string, Map<string, string>> {
  const choices = new Map<string, Map<string, string>>();
  for (const choice of model.choices) {
    choices.set(choice.path, new Map(choice.cases.map(casus => [casus.name, casus.name])));
  }
  return choices;
}

/**
 * The fields to render for the current case selection: always-on fields plus
 * the fields of each selected case. An unknown choice path or case name is a
 * binding bug and throws (fail loudly instead of silently hiding fields).
 */
export function activeCaseFields(model: FormModel, selected: ActiveCases = new Map()): FormField[] {
  const known = choicesOf(model);
  for (const [choicePath, caseName] of selected) {
    const choice = known.get(choicePath);
    if (!choice) throw new Error(`Unknown choice '${choicePath}' (form model has: ${[...known.keys()].join(", ") || "none"})`);
    if (caseName && !choice.has(caseName)) {
      throw new Error(`Unknown case '${caseName}' for choice '${choicePath}' (form model has: ${[...choice.keys()].join(", ") || "none"})`);
    }
  }
  return model.fields.filter(field =>
    field.casePath === undefined || field.caseName === undefined
    || (selected.get(field.casePath) ?? "") === field.caseName);
}

/**
 * Required value paths for the current selection: always-required fields
 * (mandatory, list keys) plus the mandatory leaves of the selected cases'
 * own `requiredFieldPaths` (RFC 7950 §7.9: only the active case's mandatory
 * leaves must be present).
 */
export function activeRequiredValues(model: FormModel, selected: ActiveCases = new Map()): string[] {
  const required = model.fields.filter(field => field.required && field.casePath === undefined).map(field => field.path);
  for (const choice of model.choices) {
    const caseName = selected.get(choice.path);
    if (!caseName) continue;
    const casus = choice.cases.find(candidat => candidat.name === caseName);
    if (casus) required.push(...casus.requiredFieldPaths);
  }
  return required;
}

/** The fields of every entry of one list, in path order (full paths, `[*]` included). */
export function listEntryFields(model: FormModel, listPath: string): FormField[] {
  const prefix = listPath.endsWith("/") ? listPath : `${listPath}/`;
  const fields = model.fields.filter(field => field.path.startsWith(prefix));
  if (!fields.length) {
    throw new Error(`No form fields under '${listPath}' (unknown or childless list)`);
  }
  return fields;
}

/** The entry record at `index` (the values map's own contract); missing entry = `{}`. */
export function listEntryValues(values: FormValues, listPath: string, index: number): FormValues {
  const entries = values[listPath];
  if (entries === undefined) return {};
  if (!Array.isArray(entries)) {
    throw new Error(`List value for '${listPath}' must be an array of entry records`);
  }
  return (entries[index] ?? {}) as FormValues;
}

/**
 * Replace (or append, when `index === entries.length`) one entry record and
 * return a NEW values map — the input is never mutated, so React state can
 * treat the result as the next snapshot.
 */
export function withListEntry(values: FormValues, listPath: string, index: number, entry: FormValues): FormValues {
  const entries = values[listPath] ?? [];
  if (!Array.isArray(entries)) {
    throw new Error(`List value for '${listPath}' must be an array of entry records`);
  }
  if (index > entries.length) {
    throw new Error(`Entry index ${index} is out of range for '${listPath}' (${entries.length} entries; append at ${entries.length})`);
  }
  const next = entries.slice();
  next[index] = entry;
  return { ...values, [listPath]: next };
}
