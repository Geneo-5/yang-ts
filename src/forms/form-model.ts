import { YangModule, YangStatement } from "../yang/ast.js";
import { childOf, childrenOf } from "../yang/parser.js";

export type FormValidationStatus = "valid" | "invalid" | "indeterminate";
export type FormControlKind = "text" | "number" | "boolean" | "enum" | "bits" | "unsupported";

export interface FormOption { value: string; label: string; description?: string }
export interface FormConstraint {
  kind: "must" | "when" | "if-feature" | "unsupported";
  expression: string;
  errorMessage?: string;
  source: YangStatement;
}
export interface FormError { code: string; message: string; source?: YangStatement }
export interface FormValidationResult {
  status: FormValidationStatus;
  errors: FormError[];
  pending: FormConstraint[];
}
export interface FormField {
  name: string;
  path: string;
  module: string;
  control: FormControlKind;
  yangType: string;
  label: string;
  help?: string;
  units?: string;
  defaultValue?: string;
  required: boolean;
  readOnly: boolean;
  multiple: boolean;
  minElements?: number;
  maxElements?: number;
  options: FormOption[];
  constraints: FormConstraint[];
  source: YangStatement;
  /** True when the field type/typedef chain could not be resolved from the supplied modules. */
  unresolvedType: boolean;
}
export interface FormModel {
  module: string;
  fields: FormField[];
  /** Module-level limitations are explicit; callers should not imply full YANG validation. */
  completeness: "type-validation-with-pending-yang-constraints";
}
export interface FormModelOptions {
  /** Imported modules available for typedef resolution. Include the complete import closure. */
  modules?: readonly YangModule[];
}

interface ResolvedType { name: string; layers: YangStatement[]; unresolved: boolean; unionTypes?: ResolvedType[] }

const BUILTIN = new Set([
  "binary", "bits", "boolean", "decimal64", "empty", "enumeration", "identityref", "instance-identifier",
  "int8", "int16", "int32", "int64", "leafref", "string", "uint8", "uint16", "uint32", "uint64", "union",
]);
const CONTROL_BY_TYPE: Record<string, FormControlKind> = {
  boolean: "boolean", enumeration: "enum", bits: "bits", string: "text", binary: "text",
  int8: "number", int16: "number", int32: "number", int64: "number", uint8: "number", uint16: "number", uint32: "number", uint64: "number", decimal64: "number",
};

function resolveType(owner: YangModule, typeStatement: YangStatement, allModules: readonly YangModule[], stack: Set<string>): ResolvedType {
  const name = typeStatement.argument ?? "";
  if (BUILTIN.has(name)) {
    if (name === "union") {
      const unionTypes = childrenOf(typeStatement, "type").map(child => resolveType(owner, child, allModules, stack));
      return { name, layers: [typeStatement], unresolved: unionTypes.some(type => type.unresolved), unionTypes };
    }
    return { name, layers: [typeStatement], unresolved: false };
  }

  let targetModule = owner;
  let typedefName = name;
  if (name.includes(":")) {
    const [prefix, localName] = name.split(":", 2);
    typedefName = localName ?? "";
    const importedName = childrenOf(owner, "import").find(importNode => childOf(importNode, "prefix")?.argument === prefix)?.argument;
    if (!importedName) return { name, layers: [typeStatement], unresolved: true };
    targetModule = allModules.find(module => module.argument === importedName) ?? owner;
    if (targetModule.argument !== importedName) return { name, layers: [typeStatement], unresolved: true };
  }

  const key = `${targetModule.argument}:${typedefName}`;
  if (stack.has(key)) return { name, layers: [typeStatement], unresolved: true };
  const typedef = findTypedef(targetModule, typedefName);
  const baseType = typedef && childOf(typedef, "type");
  if (!baseType) return { name, layers: [typeStatement], unresolved: true };
  const nextStack = new Set(stack);
  nextStack.add(key);
  const resolved = resolveType(targetModule, baseType, allModules, nextStack);
  return { ...resolved, layers: [typeStatement, ...resolved.layers] };
}

function findTypedef(module: YangModule, name: string): YangStatement | undefined {
  const visit = (node: YangStatement): YangStatement | undefined => {
    for (const child of node.children) {
      if (child.keyword === "typedef" && child.argument === name) return child;
      const nested = visit(child);
      if (nested) return nested;
    }
    return undefined;
  };
  return visit(module);
}

function typedefHelp(owner: YangModule, typeStatement: YangStatement, allModules: readonly YangModule[], visited = new Set<string>()): string[] {
  const name = typeStatement.argument ?? "";
  if (!name || BUILTIN.has(name)) return [];
  let targetModule = owner;
  let typedefName = name;
  if (name.includes(":")) {
    const [prefix, localName] = name.split(":", 2);
    typedefName = localName ?? "";
    const importedName = childrenOf(owner, "import").find(item => childOf(item, "prefix")?.argument === prefix)?.argument;
    const imported = allModules.find(item => item.argument === importedName);
    if (!imported) return [];
    targetModule = imported;
  }
  const key = `${targetModule.argument}:${typedefName}`;
  if (visited.has(key)) return [];
  visited.add(key);
  const typedef = findTypedef(targetModule, typedefName);
  if (!typedef) return [];
  const base = childOf(typedef, "type");
  return [childOf(typedef, "description")?.argument, ...(base ? typedefHelp(targetModule, base, allModules, visited) : [])].filter((item): item is string => Boolean(item));
}

function constraintsOn(node: YangStatement): FormConstraint[] {
  const out: FormConstraint[] = [];
  for (const keyword of ["must", "when", "if-feature"] as const) {
    for (const statement of childrenOf(node, keyword)) {
      const errorMessage = childOf(statement, "error-message")?.argument;
      out.push({ kind: keyword, expression: statement.argument ?? "", ...(errorMessage ? { errorMessage } : {}), source: statement });
    }
  }
  return out;
}

function optionsFromType(type: ResolvedType): FormOption[] {
  const enumLayer = type.layers.find(layer => layer.argument === "enumeration");
  if (enumLayer) return childrenOf(enumLayer, "enum").map(option => ({
    value: option.argument ?? "", label: option.argument ?? "",
    ...(childOf(option, "description")?.argument ? { description: childOf(option, "description")!.argument! } : {}),
  }));
  const bitsLayer = type.layers.find(layer => layer.argument === "bits");
  if (bitsLayer) return childrenOf(bitsLayer, "bit").map(option => ({
    value: option.argument ?? "", label: option.argument ?? "",
    ...(childOf(option, "description")?.argument ? { description: childOf(option, "description")!.argument! } : {}),
  }));
  return [];
}

function walkFields(
  owner: YangModule,
  parent: YangStatement,
  parentPath: string,
  allModules: readonly YangModule[],
  inheritedConstraints: FormConstraint[],
  fields: FormField[],
  scope: "data" | "rpc-input" | "rpc-output" | "action-input" | "action-output",
  keyNames: Set<string> = new Set(),
  inheritedReadOnly = false,
): void {
  const containers = new Set(["container", "list", "input", "output"]);
  for (const node of parent.children) {
    if (node.keyword === "rpc" || node.keyword === "action") {
      for (const input of childrenOf(node, "input")) walkFields(owner, input, `${parentPath}/${node.argument}/input`, allModules, inheritedConstraints, fields, node.keyword === "rpc" ? "rpc-input" : "action-input", new Set(), false);
      for (const output of childrenOf(node, "output")) walkFields(owner, output, `${parentPath}/${node.argument}/output`, allModules, inheritedConstraints, fields, node.keyword === "rpc" ? "rpc-output" : "action-output", new Set(), false);
      continue;
    }
    if (containers.has(node.keyword)) {
      const segment = node.keyword === "input" || node.keyword === "output" ? node.keyword : node.argument ?? node.keyword;
      const path = `${parentPath}/${segment}${node.keyword === "list" ? "[*]" : ""}`;
      const listKeys = node.keyword === "list" ? new Set((childOf(node, "key")?.argument ?? "").split(/\s+/).filter(Boolean)) : new Set<string>();
      walkFields(owner, node, path, allModules, [...inheritedConstraints, ...constraintsOn(node)], fields, scope, listKeys, inheritedReadOnly || childOf(node, "config")?.argument === "false");
      continue;
    }
    if (node.keyword === "choice" || node.keyword === "case") {
      walkFields(owner, node, parentPath, allModules, [...inheritedConstraints, ...constraintsOn(node)], fields, scope, keyNames, inheritedReadOnly);
      continue;
    }
    if (node.keyword !== "leaf" && node.keyword !== "leaf-list") continue;

    const name = node.argument ?? "";
    const typeStatement = childOf(node, "type");
    if (!typeStatement) continue;
    const resolved = resolveType(owner, typeStatement, allModules, new Set());
    const typedModule = scope === "data" ? owner : owner;
    const descriptions = [
      childOf(node, "description")?.argument,
      ...typedefHelp(owner, typeStatement, allModules),
      ...resolved.layers.map(layer => childOf(layer, "description")?.argument),
    ].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
    const description = descriptions.join("\n\n");
    const path = `${parentPath}/${name}`;
    const constraints = [...inheritedConstraints, ...constraintsOn(node)];
    const field: FormField = {
      name, path, module: typedModule.argument, control: CONTROL_BY_TYPE[resolved.name] ?? "unsupported", yangType: resolved.name,
      label: name,
      ...(description ? { help: description } : {}),
      ...(childOf(node, "units")?.argument ? { units: childOf(node, "units")!.argument! } : {}),
      ...(childOf(node, "default")?.argument ? { defaultValue: childOf(node, "default")!.argument! } : {}),
      required: childOf(node, "mandatory")?.argument === "true" || keyNames.has(name),
      readOnly: inheritedReadOnly || childOf(node, "config")?.argument === "false",
      multiple: node.keyword === "leaf-list",
      ...(childOf(node, "min-elements")?.argument ? { minElements: Number(childOf(node, "min-elements")!.argument) } : {}),
      ...(childOf(node, "max-elements")?.argument ? { maxElements: Number(childOf(node, "max-elements")!.argument) } : {}),
      options: optionsFromType(resolved), constraints, source: node, unresolvedType: resolved.unresolved,
    };
    fieldTypeLayers.set(field, resolved.layers);
    fields.push(field);
  }
}

/** Build framework-neutral form metadata from a parsed YANG module. */
export function createFormModel(module: YangModule, options: FormModelOptions = {}): FormModel {
  const modules = [module, ...(options.modules ?? []).filter(candidate => candidate.argument !== module.argument)];
  const fields: FormField[] = [];
  walkFields(module, module, "", modules, [], fields, "data");
  return { module: module.argument, fields, completeness: "type-validation-with-pending-yang-constraints" };
}

function absent(value: unknown): boolean { return value === undefined || value === null || value === ""; }
function intBounds(type: string): [bigint, bigint] | undefined {
  const signed: Record<string, number> = { int8: 8, int16: 16, int32: 32, int64: 64 };
  const unsigned: Record<string, number> = { uint8: 8, uint16: 16, uint32: 32, uint64: 64 };
  if (signed[type]) { const bits = BigInt(signed[type]!); return [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n]; }
  if (unsigned[type]) { const bits = BigInt(unsigned[type]!); return [0n, (1n << bits) - 1n]; }
  return undefined;
}

function decimalScaled(value: string, fractionDigits: number): bigint | undefined {
  if (!/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return undefined;
  const negative = value.startsWith("-");
  const unsigned = value.replace(/^[+-]/, "");
  const [whole = "0", fraction = ""] = unsigned.split(".");
  if (fraction.length > fractionDigits) return undefined;
  const scaled = BigInt(whole) * 10n ** BigInt(fractionDigits) + BigInt((fraction + "0".repeat(fractionDigits)).slice(0, fractionDigits) || "0");
  return negative ? -scaled : scaled;
}

function rangeIntervals(layers: YangStatement[]): string[] {
  return layers.flatMap(layer => childrenOf(layer, "range").map(statement => statement.argument ?? ""));
}
function lengthIntervals(layers: YangStatement[]): string[] {
  return layers.flatMap(layer => childrenOf(layer, "length").map(statement => statement.argument ?? ""));
}
function inIntervals(value: bigint, expression: string, decimalDigits?: number): boolean {
  return expression.split("|").some(part => {
    const endpoints = part.trim().split("..");
    const parse = (endpoint: string): bigint | undefined => {
      if (endpoint === "min" || endpoint === "max") return undefined;
      return decimalDigits === undefined ? (/^[+-]?\d+$/.test(endpoint) ? BigInt(endpoint) : undefined) : decimalScaled(endpoint, decimalDigits);
    };
    const lo = parse(endpoints[0] ?? "");
    const hi = parse(endpoints[1] ?? endpoints[0] ?? "");
    return (lo === undefined || value >= lo) && (hi === undefined || value <= hi);
  });
}

function validateType(field: FormField, value: unknown, errors: FormError[]): boolean | undefined {
  if (field.unresolvedType || field.control === "unsupported") return undefined;
  if (field.yangType === "boolean") {
    if (value === true || value === false || value === "true" || value === "false") return true;
    errors.push({ code: "type.boolean", message: `${field.label} must be true or false.` }); return false;
  }
  if (field.yangType === "enumeration") {
    if (field.options.some(option => option.value === value)) return true;
    errors.push({ code: "type.enum", message: `Choose one of: ${field.options.map(option => option.label).join(", ")}.` }); return false;
  }
  if (field.yangType === "bits") {
    const selected = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.trim().split(/\s+/).filter(Boolean) : [];
    const allowed = new Set(field.options.map(option => option.value));
    const invalid = selected.filter(bit => !allowed.has(bit));
    if (invalid.length) { errors.push({ code: "type.bits", message: `Unknown bit${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}.` }); return false; }
    if (new Set(selected).size !== selected.length) { errors.push({ code: "type.bits.duplicate", message: "A bit may only be selected once." }); return false; }
    return true;
  }
  if (field.yangType === "binary") return undefined;
  if (field.yangType === "string") {
    if (typeof value !== "string") { errors.push({ code: "type.string", message: `${field.label} must be text.` }); return false; }
    const length = BigInt([...value].length);
    for (const expression of lengthIntervals(fieldTypeLayers.get(field) ?? [])) {
      if (!inIntervals(length, expression)) { errors.push({ code: "constraint.length", message: `${field.label} has a length outside ${expression}.` }); return false; }
    }
    return true;
  }
  if (intBounds(field.yangType)) {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      errors.push({ code: "type.integer.precision", message: `${field.label} must be supplied as a string when it exceeds JavaScript's safe integer range.` }); return false;
    }
    const text = typeof value === "bigint" ? value.toString() : String(value);
    if (!/^[+-]?\d+$/.test(text)) { errors.push({ code: "type.integer", message: `${field.label} must be an integer.` }); return false; }
    const integer = BigInt(text);
    const [minimum, maximum] = intBounds(field.yangType)!;
    if (integer < minimum || integer > maximum) { errors.push({ code: "constraint.range", message: `${field.label} is outside the ${field.yangType} range.` }); return false; }
    for (const expression of rangeIntervals(fieldTypeLayers.get(field) ?? [])) {
      if (!inIntervals(integer, expression)) { errors.push({ code: "constraint.range", message: `${field.label} must be within ${expression}.` }); return false; }
    }
    return true;
  }
  if (field.yangType === "decimal64") {
    const layers = fieldTypeLayers.get(field) ?? [];
    const digits = Number(layers.map(layer => childOf(layer, "fraction-digits")?.argument).find(Boolean));
    if (!Number.isInteger(digits) || digits < 1 || digits > 18 || typeof value !== "string" && typeof value !== "number") {
      errors.push({ code: "type.decimal64", message: `${field.label} must be a decimal value.` }); return false;
    }
    const scaled = decimalScaled(String(value), digits);
    if (scaled === undefined) { errors.push({ code: "type.decimal64.precision", message: `${field.label} supports at most ${digits} fractional digits.` }); return false; }
    if (scaled < -(1n << 63n) || scaled > (1n << 63n) - 1n) {
      errors.push({ code: "constraint.decimal64.range", message: `${field.label} is outside the decimal64 range for ${digits} fraction digits.` }); return false;
    }
    for (const expression of rangeIntervals(layers)) {
      if (!inIntervals(scaled, expression, digits)) { errors.push({ code: "constraint.range", message: `${field.label} must be within ${expression}.` }); return false; }
    }
    return true;
  }
  return undefined;
}

// Keep the parsed type chain out of the serializable/UI-facing field object.
const fieldTypeLayers = new WeakMap<FormField, YangStatement[]>();

/** Validate requiredness and the built-in type/restrictions we can evaluate safely. */
export function validateFormValue(field: FormField, value: unknown): FormValidationResult {
  const errors: FormError[] = [];
  if (absent(value)) {
    if (field.required) errors.push({ code: "required", message: `${field.label} is required.` });
    if (field.multiple && field.minElements !== undefined && field.minElements > 0) {
      errors.push({ code: "constraint.min-elements", message: `${field.label} needs at least ${field.minElements} value(s).` });
    }
    const pending = field.constraints;
    return { status: errors.length ? "invalid" : pending.length ? "indeterminate" : "valid", errors, pending };
  }
  let result: boolean | undefined;
  if (field.multiple) {
    if (!Array.isArray(value)) {
      errors.push({ code: "type.array", message: `${field.label} must be a list of values.` });
      result = false;
    } else {
      if (field.minElements !== undefined && value.length < field.minElements) errors.push({ code: "constraint.min-elements", message: `${field.label} needs at least ${field.minElements} value(s).` });
      if (field.maxElements !== undefined && value.length > field.maxElements) errors.push({ code: "constraint.max-elements", message: `${field.label} allows at most ${field.maxElements} value(s).` });
      if (new Set(value.map(item => JSON.stringify(item))).size !== value.length) errors.push({ code: "constraint.unique", message: `${field.label} cannot contain duplicate values.` });
      const single = { ...field, multiple: false };
      fieldTypeLayers.set(single, fieldTypeLayers.get(field) ?? []);
      let unknown = false;
      for (const item of value) {
        const valid = validateType(single, item, errors);
        if (valid === false) result = false;
        if (valid === undefined) unknown = true;
      }
      if (result !== false) result = unknown ? undefined : true;
    }
  } else {
    result = validateType(field, value, errors);
  }
  const hasPattern = (fieldTypeLayers.get(field) ?? []).some(layer => childrenOf(layer, "pattern").length > 0);
  const unsupportedConstraint = hasPattern
    || ["binary", "leafref", "identityref", "instance-identifier"].includes(field.yangType);
  const pending = [...field.constraints];
  if (hasPattern) pending.push({ kind: "unsupported", expression: "pattern requires XML Schema regular-expression evaluation", source: field.source });
  if (["leafref", "identityref", "instance-identifier"].includes(field.yangType)) {
    pending.push({ kind: "unsupported", expression: `${field.yangType} requires cross-reference/schema validation`, source: field.source });
  }
  if (field.yangType === "binary") pending.push({ kind: "unsupported", expression: "binary requires base64/octet validation", source: field.source });
  if (field.unresolvedType) pending.push({ kind: "unsupported", expression: `type '${field.yangType}' was not resolved`, source: field.source });
  if (errors.length) return { status: "invalid", errors, pending };
  if (result === undefined || pending.length || unsupportedConstraint) return { status: "indeterminate", errors, pending };
  return { status: "valid", errors, pending };
}
