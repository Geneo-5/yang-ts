import { YangModule, YangStatement } from "../yang/ast.js";
import { CompiledYangSchema, isIdentityDerivedFrom } from "../yang/compiler.js";
import { childOf, childrenOf } from "../yang/parser.js";
import { findSchemaNodeByPath } from "../xpath/accessible-tree.js";
import { compileModuleExpression } from "../xpath/evaluate-constraints.js";

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
  scope: "data" | "rpc-input" | "rpc-output" | "action-input" | "action-output";
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
  operations: FormRpcOperation[];
  /** Module-level limitations are explicit; callers should not imply full YANG validation. */
  completeness: "type-validation-with-pending-yang-constraints";
}
export interface FormRpcOperation {
  kind: "rpc";
  name: string;
  module: string;
  label: string;
  help?: string;
  hasInput: boolean;
  hasOutput: boolean;
  inputFields: FormField[];
  outputFields: FormField[];
  source: YangStatement;
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
  const optionList = (keyword: "enum" | "bit"): FormOption[] => {
    let baseIndex = -1;
    const baseTypeName = keyword === "enum" ? "enumeration" : "bits";
    for (let index = type.layers.length - 1; index >= 0; index--) {
      if (type.layers[index]?.argument === baseTypeName) { baseIndex = index; break; }
    }
    if (baseIndex < 0) return [];
    let options = childrenOf(type.layers[baseIndex]!, keyword).map(option => ({
      value: option.argument ?? "", label: option.argument ?? "",
      ...(childOf(option, "description")?.argument ? { description: childOf(option, "description")!.argument! } : {}),
    }));
    for (let index = baseIndex - 1; index >= 0; index--) {
      const restrictedNames = childrenOf(type.layers[index]!, keyword).map(option => option.argument ?? "");
      if (restrictedNames.length) {
        const allowed = new Set(restrictedNames);
        options = options.filter(option => allowed.has(option.value));
      }
    }
    return options;
  };
  const enums = optionList("enum");
  if (enums.length) return enums;
  const bits = optionList("bit");
  if (bits.length) return bits;
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
      name, path, module: typedModule.argument, scope, control: CONTROL_BY_TYPE[resolved.name] ?? "unsupported", yangType: resolved.name,
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
    fieldResolvedTypes.set(field, resolved);
    fields.push(field);
  }
}

/** Build framework-neutral form metadata from a parsed YANG module. */
export function createFormModel(module: YangModule, options: FormModelOptions = {}): FormModel {
  const modules = [module, ...(options.modules ?? []).filter(candidate => candidate.argument !== module.argument)];
  const fields: FormField[] = [];
  walkFields(module, module, "", modules, [], fields, "data");
  const operations: FormRpcOperation[] = childrenOf(module, "rpc").map(rpc => {
    const name = rpc.argument ?? "";
    const prefix = `/${name}/`;
    const description = childOf(rpc, "description")?.argument;
    return {
      kind: "rpc", name, module: module.argument, label: name,
      ...(description ? { help: description } : {}),
      hasInput: childrenOf(rpc, "input").length > 0,
      hasOutput: childrenOf(rpc, "output").length > 0,
      inputFields: fields.filter(field => field.scope === "rpc-input" && field.path.startsWith(`${prefix}input/`)),
      outputFields: fields.filter(field => field.scope === "rpc-output" && field.path.startsWith(`${prefix}output/`)),
      source: rpc,
    };
  });
  return { module: module.argument, fields, operations, completeness: "type-validation-with-pending-yang-constraints" };
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

function base64OctetLength(value: string): number | undefined {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (padding === 2 && (alphabet.indexOf(value[value.length - 3] ?? "") & 15) !== 0) return undefined;
  if (padding === 1 && (alphabet.indexOf(value[value.length - 2] ?? "") & 3) !== 0) return undefined;
  return value.length / 4 * 3 - padding;
}

// RFC 7950 section 9.4.6 patterns are implicitly-anchored XML Schema
// regular expressions. JavaScript regexes agree on the common subset, but not
// on backreferences, `(?`-prefixed groups or character-class subtraction, where
// JavaScript silently accepts and misinterprets the syntax; such patterns stay
// pending instead of being evaluated with the wrong rules.
const patternCache = new Map<string, RegExp | undefined>();
function compilePattern(pattern: string): RegExp | undefined {
  const cached = patternCache.get(pattern);
  if (cached !== undefined) return cached;
  if (patternCache.has(pattern)) return undefined;
  let compiled: RegExp | undefined;
  if (!/\\\d|\(\?/.test(pattern) && !hasCharacterClassSubtraction(pattern)) {
    try { compiled = new RegExp(`^(?:${pattern})$`); } catch { compiled = undefined; }
  }
  patternCache.set(pattern, compiled);
  return compiled;
}
function hasCharacterClassSubtraction(pattern: string): boolean {
  let inside = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (inside && character === "\\") { index++; continue; }
    if (character === "[") inside = true;
    else if (character === "]") inside = false;
    else if (inside && character === "-" && pattern[index + 1] === "[") return true;
  }
  return false;
}

interface EffectiveIntervalConstraint { expression: string; minimum: bigint; maximum: bigint; }
function inheritedIntervals(
  layers: YangStatement[], keyword: "range" | "length", minimum: bigint, maximum: bigint, decimalDigits?: number,
): EffectiveIntervalConstraint[] {
  let inheritedMinimum = minimum;
  let inheritedMaximum = maximum;
  const constraints: EffectiveIntervalConstraint[] = [];
  const parse = (endpoint: string): bigint | undefined => {
    if (endpoint === "min") return inheritedMinimum;
    if (endpoint === "max") return inheritedMaximum;
    return decimalDigits === undefined
      ? (/^[+-]?\d+$/.test(endpoint) ? BigInt(endpoint) : undefined)
      : decimalScaled(endpoint, decimalDigits);
  };
  for (const layer of [...layers].reverse()) for (const statement of childrenOf(layer, keyword)) {
    const expression = statement.argument ?? "";
    constraints.push({ expression, minimum: inheritedMinimum, maximum: inheritedMaximum });
    const intervals = expression.split("|").map(part => {
      const endpoints = part.trim().split("..");
      const lowText = endpoints[0] ?? "";
      const highText = endpoints[1] ?? lowText;
      return [parse(lowText), parse(highText)] as const;
    });
    const lows = intervals.map(interval => interval[0]).filter((value): value is bigint => value !== undefined);
    const highs = intervals.map(interval => interval[1]).filter((value): value is bigint => value !== undefined);
    if (lows.length) inheritedMinimum = lows.reduce((a, b) => a < b ? a : b);
    if (highs.length) inheritedMaximum = highs.reduce((a, b) => a > b ? a : b);
  }
  return constraints;
}
function inIntervals(value: bigint, expression: string, decimalDigits?: number, bounds?: readonly [bigint, bigint]): boolean {
  return expression.split("|").some(part => {
    const endpoints = part.trim().split("..");
    const parse = (endpoint: string): bigint | undefined => {
      if (endpoint === "min") return bounds?.[0];
      if (endpoint === "max") return bounds?.[1];
      return decimalDigits === undefined ? (/^[+-]?\d+$/.test(endpoint) ? BigInt(endpoint) : undefined) : decimalScaled(endpoint, decimalDigits);
    };
    const lo = parse(endpoints[0] ?? "");
    const hi = parse(endpoints[1] ?? endpoints[0] ?? "");
    return (lo === undefined || value >= lo) && (hi === undefined || value <= hi);
  });
}

function validateType(field: FormField, value: unknown, errors: FormError[]): boolean | undefined {
  if (field.unresolvedType || (field.control === "unsupported" && field.yangType !== "union")) return undefined;
  if (field.yangType === "union") {
    const resolved = fieldResolvedTypes.get(field);
    if (!resolved?.unionTypes?.length) return undefined;
    let indeterminate = false;
    for (const member of resolved.unionTypes) {
      const candidate: FormField = {
        ...field, yangType: member.name, control: CONTROL_BY_TYPE[member.name] ?? "unsupported",
        options: optionsFromType(member), unresolvedType: member.unresolved,
      };
      fieldTypeLayers.set(candidate, member.layers);
      fieldResolvedTypes.set(candidate, member);
      const branchErrors: FormError[] = [];
      const result = validateType(candidate, value, branchErrors);
      if (result === true) return true;
      if (result === undefined) indeterminate = true;
    }
    if (indeterminate) return undefined;
    errors.push({ code: "type.union", message: `${field.label} does not match any member type.` });
    return false;
  }
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
  if (field.yangType === "binary") {
    if (typeof value !== "string") { errors.push({ code: "type.binary", message: `${field.label} must be base64 text.` }); return false; }
    const octets = base64OctetLength(value);
    if (octets === undefined) { errors.push({ code: "type.binary.base64", message: `${field.label} must use canonical base64 encoding.` }); return false; }
    for (const constraint of inheritedIntervals(fieldTypeLayers.get(field) ?? [], "length", 0n, (1n << 64n) - 1n)) {
      if (!inIntervals(BigInt(octets), constraint.expression, undefined, [constraint.minimum, constraint.maximum])) {
        errors.push({ code: "constraint.length", message: `${field.label} has a decoded length outside ${constraint.expression} octets.` }); return false;
      }
    }
    return true;
  }
  if (field.yangType === "string") {
    if (typeof value !== "string") { errors.push({ code: "type.string", message: `${field.label} must be text.` }); return false; }
    const length = BigInt([...value].length);
    for (const constraint of inheritedIntervals(fieldTypeLayers.get(field) ?? [], "length", 0n, (1n << 64n) - 1n)) {
      if (!inIntervals(length, constraint.expression, undefined, [constraint.minimum, constraint.maximum])) { errors.push({ code: "constraint.length", message: `${field.label} has a length outside ${constraint.expression}.` }); return false; }
    }
    if (typeof value === "string") {
      for (const layer of fieldTypeLayers.get(field) ?? []) for (const patternStatement of childrenOf(layer, "pattern")) {
        const pattern = compilePattern(patternStatement.argument ?? "");
        if (!pattern) continue;
        if (!pattern.test(value)) { errors.push({ code: "constraint.pattern", message: `${field.label} does not match pattern '${patternStatement.argument ?? ""}'.` }); return false; }
      }
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
    for (const constraint of inheritedIntervals(fieldTypeLayers.get(field) ?? [], "range", minimum, maximum)) {
      if (!inIntervals(integer, constraint.expression, undefined, [constraint.minimum, constraint.maximum])) { errors.push({ code: "constraint.range", message: `${field.label} must be within ${constraint.expression}.` }); return false; }
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
    const decimalMinimum = -(1n << 63n);
    const decimalMaximum = (1n << 63n) - 1n;
    for (const constraint of inheritedIntervals(layers, "range", decimalMinimum, decimalMaximum, digits)) {
      if (!inIntervals(scaled, constraint.expression, digits, [constraint.minimum, constraint.maximum])) { errors.push({ code: "constraint.range", message: `${field.label} must be within ${constraint.expression}.` }); return false; }
    }
    return true;
  }
  return undefined;
}

// Keep the parsed type chain out of the serializable/UI-facing field object.
const fieldTypeLayers = new WeakMap<FormField, YangStatement[]>();
const fieldResolvedTypes = new WeakMap<FormField, ResolvedType>();

/** Validate requiredness and the built-in type/restrictions we can evaluate safely. */
export function validateFormValue(
  field: FormField,
  value: unknown,
  crossReference?: FormCrossReference,
): FormValidationResult {
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
  const crossReferencePending = validateCrossReference(field, value, errors, crossReference);
  // A cross-reference type has no generic value check of its own; when the
  // context-backed cross-reference check ran, it is the value's verdict.
  if (result === undefined && (field.yangType === "leafref" || field.yangType === "identityref") && !crossReferencePending) result = true;
  const hasPattern = (fieldTypeLayers.get(field) ?? []).some(layer => childrenOf(layer, "pattern").length > 0);
  const unsupportedPattern = hasPattern && (field.yangType !== "string"
    || (fieldTypeLayers.get(field) ?? []).some(layer => childrenOf(layer, "pattern")
      .some(patternStatement => !compilePattern(patternStatement.argument ?? ""))));
  const pending = [...field.constraints];
  if (crossReferencePending) {
    pending.push({ kind: "unsupported", expression: `${field.yangType} requires cross-reference/schema validation`, source: field.source });
  }
  const unsupportedConstraint = unsupportedPattern || crossReferencePending || field.yangType === "instance-identifier";
  if (unsupportedPattern) {
    pending.push({ kind: "unsupported", expression: "pattern requires XML Schema regular-expression evaluation", source: field.source });
  }
  if (field.unresolvedType) pending.push({ kind: "unsupported", expression: `type '${field.yangType}' was not resolved`, source: field.source });
  if (errors.length) return { status: "invalid", errors, pending };
  if (result === undefined || pending.length || unsupportedConstraint) return { status: "indeterminate", errors, pending };
  return { status: "valid", errors, pending };
}

/**
 * Compiled context that lets form validation check cross-reference types in
 * place of reporting them as pending: `leafref` values are resolved against
 * the anchor element's document with the declared path, and `identityref`
 * values are checked against the schema's identity derivation. Without a
 * context these types remain indeterminate with an explicit pending reason.
 */
export interface FormCrossReference {
  schema: CompiledYangSchema;
  /**
   * Instance element the leafref path is evaluated from — normally the field's
   * own data node (or a probe in its parent list entry) so relative paths such
   * as `../route/name` resolve against real sibling data.
   */
  anchor?: Element;
}

/**
 * Returns false when the cross-reference check ran (whether it passed or
 * rejected the value) and true when the type still needs context that was not
 * supplied. Errors are reported through the shared error list.
 */
function validateCrossReference(field: FormField, value: unknown, errors: FormError[], crossReference?: FormCrossReference): boolean {
  if (field.yangType !== "leafref" && field.yangType !== "identityref") return false;
  if (!crossReference) return true;
  if (field.yangType === "leafref") {
    if (!crossReference.anchor) return true;
    const schemaNode = findSchemaNodeByPath(crossReference.schema, field.path);
    if (schemaNode?.resolvedType !== "leafref") return true;
    const text = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
    if (text === undefined || text === "") { errors.push({ code: "type.leafref", message: `${field.label} must be a node reference.` }); return false; }
    // Evaluate the declared path against the anchor element but match it
    // against the submitted value: unlike tree validation, the form value is
    // not committed to the element yet.
    const pathArgument = schemaNode.type ? childOf(schemaNode.type, "path")?.argument : undefined;
    if (!pathArgument) return true;
    const compiled = compileModuleExpression(crossReference.schema, schemaNode.module, pathArgument);
    if (!compiled) return true;
    let reached: Element[];
    try {
      reached = compiled.select({ node: crossReference.anchor })
        .filter((child): child is Element => (child as Node).nodeType === 1 && (child as Element).textContent === text);
    } catch {
      return true;
    }
    if (!reached.length) { errors.push({ code: "constraint.leafref", message: `${field.label} does not reference an existing node.` }); return false; }
    return false;
  }
  // RFC 7950 section 9.10: an identityref evaluates to an identity derived
  // from one of the type's declared bases. Values may be module-qualified
  // ("module:name") or plain identity names; XML namespace prefixes are not
  // resolvable here and stay indeterminate through the unqualified case.
  const bases = (fieldTypeLayers.get(field) ?? [])
    .flatMap(layer => childrenOf(layer, "base").map(base => resolveBaseRef(base.argument ?? "", field.module, crossReference.schema)))
    .filter((base): base is string => Boolean(base));
  if (!bases.length) return true;
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) { errors.push({ code: "type.identityref", message: `${field.label} must name an identity.` }); return false; }
  const derived = bases.some(base => matchesIdentityBase(crossReference.schema, text, base));
  if (!derived) {
    errors.push({ code: "type.identityref", message: `${field.label} must be an identity derived from ${bases.join(", ")}.` });
  }
  return false;
}

/** Resolve a base statement's prefix to the declaring module: qualified by module name or by an imported prefix. */
function resolveBaseRef(base: string, moduleName: string, schema: CompiledYangSchema): string | undefined {
  if (!base) return undefined;
  const separator = base.indexOf(":");
  if (separator < 0) return `${moduleName}:${base}`;
  const qualifier = base.slice(0, separator);
  if (schema.modules.some(module => module.argument === qualifier)) return base;
  const owner = schema.modules.find(module => module.argument === moduleName);
  const importedName = owner && childrenOf(owner, "import")
    .find(importNode => childOf(importNode, "prefix")?.argument === qualifier)?.argument;
  return importedName ? `${importedName}:${base.slice(separator + 1)}` : undefined;
}

function matchesIdentityBase(schema: CompiledYangSchema, value: string, base: string): boolean {
  if (value.includes(":")) return value === base || isIdentityDerivedFrom(schema, value, base);
  return schema.identities.some(identity =>
    identity.name === value
    && (identity.module === base.slice(0, base.indexOf(":")) || isIdentityDerivedFrom(schema, `${identity.module}:${identity.name}`, base)));
}

/**
 * RFC 6991 canonical lexical representation of a form value for its field's
 * type: integers drop sign padding and leading zeros, decimal64 re-renders
 * with exactly its `fraction-digits`, boolean normalizes JavaScript booleans,
 * bits re-join the selection ordered by bit position, and binary strips
 * insignificant base64 whitespace. Returns `undefined` when the value is not
 * a valid lexical form for the type or the type has no canonical check here
 * (leafref/identityref/instance-identifier need cross-reference context).
 */
export function canonicalFormOf(field: FormField, value: unknown): string | undefined {
  if (field.unresolvedType || value === undefined || value === null) return undefined;
  switch (field.yangType) {
    case "boolean":
      if (value === true || value === "true") return "true";
      if (value === false || value === "false") return "false";
      return undefined;
    case "enumeration":
      return field.options.some(option => option.value === value) ? String(value) : undefined;
    case "bits": {
      const selected = Array.isArray(value) ? value.map(String)
        : typeof value === "string" ? value.trim().split(/\s+/).filter(Boolean) : [];
      const allowed = new Set(field.options.map(option => option.value));
      if (!selected.length || selected.some(bit => !allowed.has(bit)) || new Set(selected).size !== selected.length) return undefined;
      return sortByBitPosition(field, selected).join(" ");
    }
    case "binary": {
      if (typeof value !== "string") return undefined;
      const compact = value.replace(/\s+/g, "");
      return base64OctetLength(compact) !== undefined ? compact : undefined;
    }
    case "decimal64": {
      if (typeof value !== "string" && typeof value !== "number") return undefined;
      const digits = Number(inheritedFractionDigits(field));
      if (!Number.isInteger(digits) || digits < 1 || digits > 18) return undefined;
      const scaled = decimalScaled(typeof value === "number" ? String(value) : value, digits);
      if (scaled === undefined) return undefined;
      const negative = scaled < 0n;
      const magnitude = negative ? -scaled : scaled;
      const digitsText = magnitude.toString().padStart(digits + 1, "0");
      const whole = digitsText.slice(0, -digits);
      const fraction = digitsText.slice(-digits);
      return `${negative ? "-" : ""}${whole}.${fraction}`;
    }
    default: {
      // Cross-reference types need instance/schema context to judge a value.
      if (["leafref", "identityref", "instance-identifier"].includes(field.yangType)) return undefined;
      const bounds = intBounds(field.yangType);
      if (!bounds) return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
      if (typeof value === "number" && !Number.isSafeInteger(value)) return undefined;
      const text = typeof value === "bigint" ? value.toString() : String(value);
      if (!/^[+-]?\d+$/.test(text)) return undefined;
      const integer = BigInt(text);
      if (integer < bounds[0] || integer > bounds[1]) return undefined;
      return integer.toString();
    }
  }
}

function inheritedFractionDigits(field: FormField): string | undefined {
  for (const layer of fieldTypeLayers.get(field) ?? []) {
    const digits = childOf(layer, "fraction-digits")?.argument;
    if (digits !== undefined) return digits;
  }
  return undefined;
}

/** RFC 6991 canonical bits order: ascending bit position, declaration order as the default position. */
function sortByBitPosition(field: FormField, selected: string[]): string[] {
  const positions = new Map(field.options.map((option, index) => {
    for (const layer of fieldTypeLayers.get(field) ?? []) {
      const bit = childrenOf(layer, "bit").find(statement => statement.argument === option.value);
      const explicit = bit && childOf(bit, "position")?.argument;
      if (bit) return [option.value, explicit !== undefined ? Number(explicit) : index] as const;
    }
    return [option.value, index] as const;
  }));
  return selected.slice().sort((left, right) => (positions.get(left) ?? 0) - (positions.get(right) ?? 0));
}
