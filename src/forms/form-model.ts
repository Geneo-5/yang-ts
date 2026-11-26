import { YangModule, YangStatement } from "../yang/ast.js";
import { childOf, childrenOf } from "../yang/parser.js";
import { compileYangModules, CompiledOperation, CompiledSchemaNode, CompiledYangSchema, documentOf, isIdentityDerivedFrom } from "../yang/compiler.js";
import type { YangModuleSet } from "../yang/module-set.js";
import { findSchemaNodeByPath } from "../xpath/accessible-tree.js";
import { leafrefPathStatementOf, xmlNamespaceForPrefix } from "../xpath/yang-functions.js";
import { compileXsdPattern } from "../types/xsd-pattern.js";
import { BUILTIN_TYPES } from "../types/builtins.js";
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
export interface FormPatternRestriction { expression: string; invertMatch: boolean }
export interface FormBitRestriction { name: string; position: number }
export interface FormUnionMember {
  name: string;
  control: FormControlKind;
  options: FormOption[];
  unresolved: boolean;
  restrictions: FormFieldRestrictions;
}
/** Serializable type restrictions carried on the field itself, so copies, clones and reactive proxies keep validating. */
export interface FormFieldRestrictions {
  /** range expressions in layer order (declared `type` first). */
  ranges: string[];
  /** length expressions in layer order (declared `type` first). */
  lengths: string[];
  /** patterns in declaration order with their per-pattern modifier (RFC 7950 §9.4.6.2). */
  patterns: FormPatternRestriction[];
  /** decimal64 fraction digits from the first layer that declares one. */
  fractionDigits?: number;
  /** identityref base arguments in declaration order (raw; resolved against the schema at validation). */
  bases: string[];
  /** bits with RFC 7950 §9.7.6 positions: explicit or declaration order in the base bits type. */
  bits: FormBitRestriction[];
  /** union member descriptors when the field's type is a union. */
  unionMembers?: FormUnionMember[];
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
  restrictions: FormFieldRestrictions;
  constraints: FormConstraint[];
  source: YangStatement;
  /** True when the field type/typedef chain could not be resolved from the supplied modules. */
  unresolvedType: boolean;
  /** Schema path of the `choice` the field belongs to through a `case` (absent outside choices). */
  casePath?: string;
  /** Name of the immediate `case` holding the field (absent outside choices). */
  caseName?: string;
}
/** One `case` of a choice: the mandatory values a submitted entry must carry when the case is the active one. */
export interface FormChoiceCase {
  name: string;
  requiredFieldPaths: readonly string[];
}
/**
 * RFC 7950 §7.9 choice metadata: at most one case of a choice is active, so a
 * mandatory leaf of a case is required only when its case is the active one.
 * UIs and validators use the cases' `requiredFieldPaths` with the active-case
 * state instead of the fields' own `required` flags (those stay `false` inside
 * a case).
 */
export interface FormChoice {
  name: string;
  path: string;
  required: boolean;
  defaultCase?: string;
  cases: readonly FormChoiceCase[];
  source: YangStatement;
}
export interface FormModel {
  module: string;
  fields: FormField[];
  operations: FormRpcOperation[];
  /** Per top-level node module map (`name` → module): qualifiers for RESTCONF JSON bodies of multi-module schemas. */
  topModules?: Readonly<Record<string, string>>;
  choices: readonly FormChoice[];
  /** Module-level limitations are explicit; callers should not imply full YANG validation. */
  completeness: "type-validation-with-pending-yang-constraints";
}
export interface FormRpcOperation {
  kind: "rpc" | "action";
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
  /** Imported modules available for typedef resolution when a raw module is supplied. Include the complete import closure. */
  modules?: readonly YangModule[];
  /** When a compiled multi-module schema is supplied: model only this module's top-level trees (default: all roots). */
  module?: string;
}

interface ResolvedType { name: string; layers: YangStatement[]; unresolved: boolean; unionTypes?: ResolvedType[] }

const BUILTIN = BUILTIN_TYPES;
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
  return {...resolved, layers: [typeStatement, ...resolved.layers] };
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

/** Extract the serializable restriction descriptor from the resolved type layers. */
function restrictionsFromType(resolved: ResolvedType): FormFieldRestrictions {
  const ranges: string[] = [];
  const lengths: string[] = [];
  const patterns: FormPatternRestriction[] = [];
  const bases: string[] = [];
  let fractionDigits: number | undefined;
  for (const layer of resolved.layers) {
    for (const statement of childrenOf(layer, "range")) ranges.push(statement.argument ?? "");
    for (const statement of childrenOf(layer, "length")) lengths.push(statement.argument ?? "");
    for (const statement of childrenOf(layer, "pattern")) {
      patterns.push({ expression: statement.argument ?? "", invertMatch: childOf(statement, "modifier")?.argument === "invert-match" });
    }
    const digits = childOf(layer, "fraction-digits")?.argument;
    if (fractionDigits === undefined && digits !== undefined) fractionDigits = Number(digits);
    for (const statement of childrenOf(layer, "base")) bases.push(statement.argument ?? "");
  }
  // Positions default to the declaration order of the base bits type (the
  // last layer, restricted derivation never repositions bits).
  const bitsLayer = [...resolved.layers].reverse().find(layer => layer.argument === "bits");
  const bits: FormBitRestriction[] = bitsLayer
    ? childrenOf(bitsLayer, "bit").map((bit, index) => {
      const explicit = childOf(bit, "position")?.argument;
      return { name: bit.argument ?? "", position: explicit !== undefined ? Number(explicit) : index };
    })
    : [];
  const unionMembers = resolved.unionTypes?.map(member => ({
    name: member.name,
    control: CONTROL_BY_TYPE[member.name] ?? "unsupported" as const,
    options: optionsFromType(member),
    unresolved: member.unresolved,
    restrictions: restrictionsFromType(member),
  }));
  return { ranges, lengths, patterns, ...(fractionDigits !== undefined ? { fractionDigits } : {}), bases, bits, ...(unionMembers ? { unionMembers } : {}) };
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

/** The type layers of a compiled field: the node's own `type` first, then each typedef's base type, derived-most first. */
function typeLayersOf(node: CompiledSchemaNode): YangStatement[] {
  const typedefTypes = node.typedefChain
    .map(typedef => childOf(typedef, "type"))
    .filter((type): type is YangStatement => Boolean(type));
  return node.type ? [node.type, ...typedefTypes] : typedefTypes;
}

/**
 * §87 — Resolve a compiled node's type through the compiler-derived chain and
 * express it in the form-model `ResolvedType` shape (union members keep being
 * resolved from the parse tree because the compiler stores only the union's
 * built-in name, not its member chains).
 */
function resolvedOfNode(node: CompiledSchemaNode, schema: CompiledYangSchema): ResolvedType {
  const name = node.resolvedType ?? "";
  if (name === "union" && node.type) {
    const ownerDocument = documentOf(schema, node.declaredIn) ?? documentOf(schema, node.module);
    const allModules = [...schema.modules, ...schema.submodules];
    const unionTypes = ownerDocument
      ? childrenOf(node.type, "type").map(member => resolveType(ownerDocument, member, allModules, new Set()))
      : [];
    return { name, layers: typeLayersOf(node), unresolved: false, unionTypes };
  }
  return { name, layers: typeLayersOf(node), unresolved: !name };
}

/** Compiled constraint statements (must/when) and feature requirements of one node, in field-constraint shape. */
function constraintsOfNode(node: CompiledSchemaNode): FormConstraint[] {
  const out: FormConstraint[] = [];
  for (const statement of node.must) {
    const errorMessage = childOf(statement, "error-message")?.argument;
    out.push({ kind: "must", expression: statement.argument ?? "", ...(errorMessage ? { errorMessage } : {}), source: statement });
  }
  for (const [index, statement] of node.whenConstraints.entries()) {
    out.push({ kind: "when", expression: statement.argument ?? "", source: statement });
  }
  return out;
}

interface WalkContext {
  scope: FormField["scope"];
  parentPath: string;
  keyNames: Set<string>;
  choicePath?: string;
  caseName?: string;
}

/**
 * §87 — Walk compiled schema nodes (uses/augments/deviations already applied
 * by the compiler) collecting leaf/leaf-list form fields. Ancestors' must/
 * when/if-feature constraints accumulate into each field, wrapped with the
 * node they are held on (RFC 7950 §7.5.3/§7.21.5 evaluation contexts).
 */
function walkFields(
  schema: CompiledYangSchema,
  nodes: readonly CompiledSchemaNode[],
  context: WalkContext,
  inherited: { constraints: FormConstraint[]; readOnly: boolean },
  fields: FormField[],
  choices: FormChoice[],
): void {
  for (const node of nodes) {
    const path = `${context.parentPath}/${node.name}${node.kind === "list" ? "[*]" : ""}`;
    if (node.kind === "container" || node.kind === "list") {
      walkFields(schema, node.children, { ...context, parentPath: path, keyNames: node.kind === "list" ? new Set(node.keys) : context.keyNames },
        { constraints: [...inherited.constraints, ...constraintsOfNode(node)], readOnly: inherited.readOnly || !node.config },
        fields, choices);
      continue;
    }
    if (node.kind === "choice") {
      const caseList: FormChoiceCase[] = [];
      // §7.9: explicit cases plus every implicit case the compiler materialized.
      for (const caseNode of node.children) {
        if (caseNode.kind !== "case") continue;
        const caseFields: FormField[] = [];
        walkFields(schema, caseNode.children, { ...context, parentPath: context.parentPath, choicePath: path, caseName: caseNode.name },
          { constraints: [...inherited.constraints, ...constraintsOfNode(caseNode)], readOnly: inherited.readOnly || !caseNode.config },
          caseFields, choices);
        fields.push(...caseFields);
        // The case's mandatory leaves: "required" only while the case is the
        // active one — read from the compiled node (field.required is forced
        // false inside a case).
        const requiredFieldPaths = caseNode.children
          .filter(child => child.kind === "leaf" && (child.properties["mandatory"]?.[0]?.argument ?? "") === "true")
          .map(child => `${context.parentPath}/${child.name}`);
        caseList.push({ name: caseNode.name, requiredFieldPaths });
      }
      const choice: FormChoice = {
        name: node.name, path, required: (node.properties["mandatory"]?.[0]?.argument ?? "") === "true",
        ...(childOf(node.source, "default")?.argument ? { defaultCase: childOf(node.source, "default")!.argument! } : {}),
        cases: caseList, source: node.source,
      };
      choices.push(choice);
      continue;
    }
    if (node.kind !== "leaf" && node.kind !== "leaf-list") continue;

    const name = node.name;
    const resolved = resolvedOfNode(node, schema);
    const descriptions = [
      childOf(node.source, "description")?.argument,
      ...node.typedefChain.map(typedef => childOf(typedef, "description")?.argument),
      ...resolved.layers.map(layer => childOf(layer, "description")?.argument),
    ].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
    const description = descriptions.join("\n\n");
    const inheritedConstraints = [...inherited.constraints,
      // Node if-features stay pending constraints: the feature verdict lives
      // in the compiled schema (compiling with `enabledFeatures` drops the
      // node entirely); a raw feature expression needs schema context again.
      ...node.featureRequirements.map(requirement =>
        ({ kind: "if-feature", expression: requirement.expression, source: node.source } as FormConstraint))];
    const insideCase = context.caseName !== undefined && context.choicePath !== undefined;
    const mandatory = (node.properties["mandatory"]?.[0]?.argument ?? "") === "true" || context.keyNames.has(name);
    const field: FormField = {
      name, path, module: node.module, scope: context.scope, control: CONTROL_BY_TYPE[resolved.name] ?? "unsupported", yangType: resolved.name,
      label: name,
      ...(description ? { help: description } : {}),
      ...(childOf(node.source, "units")?.argument ? { units: childOf(node.source, "units")!.argument! } : {}),
      ...(node.properties["default"]?.[0]?.argument ? { defaultValue: node.properties["default"][0]!.argument! } : {}),
      // §87: a mandatory leaf inside a case is required only while its case
      // is active — the choice's models carry it instead (see FormChoice).
      required: insideCase ? false : mandatory,
      readOnly: inherited.readOnly || !node.config,
      multiple: node.kind === "leaf-list",
      ...(node.properties["min-elements"]?.[0]?.argument ? { minElements: Number(node.properties["min-elements"][0]!.argument) } : {}),
      ...(node.properties["max-elements"]?.[0]?.argument ? { maxElements: Number(node.properties["max-elements"][0]!.argument) } : {}),
      options: filterDisabledOptions(optionsFromType(resolved), node.featureDisabledValues),
      restrictions: restrictionsFromType(resolved),
      constraints: [...inheritedConstraints, ...constraintsOfNode(node)],
      source: node.source, unresolvedType: resolved.unresolved,
      ...(insideCase ? { casePath: context.choicePath, caseName: context.caseName } : {}),
    };
    fields.push(field);
  }
}

/** §48 — drop enum/bit options whose own `if-feature` is disabled (RFC 7950 §9.6.4/§9.7.4). */
function filterDisabledOptions(options: FormOption[], disabled: readonly string[] | undefined): FormOption[] {
  if (!disabled?.length) return options;
  const disabledNames = new Set(disabled);
  return options.filter(option => !disabledNames.has(option.value));
}

/**
 * Build framework-neutral form metadata from a compiled schema (§87) or, for
 * compatibility, from a parsed module (compiled on the fly with any supplied
 * `options.modules`). The compiled path carries `uses` expansions, augments,
 * deviations, rpc AND action operations, choice/case structure and the
 * compiler's feature knowledge (feature-gated enum/bit options are dropped);
 * feature-gated nodes survive as `if-feature` pending constraints unless the
 * schema was compiled with an `enabledFeatures` set.
 */
export function createFormModel(input: CompiledYangSchema | YangModule, options: FormModelOptions = {}): FormModel {
  const schema = isCompiledSchema(input) ? input : schemaOfModule(input, options);
  const roots = options.module ? schema.roots.filter(root => root.module === options.module) : schema.roots;
  const fields: FormField[] = [];
  const choices: FormChoice[] = [];
  walkFields(schema, roots, { scope: "data", parentPath: "", keyNames: new Set() }, { constraints: [], readOnly: false }, fields, choices);
  const topModules: Record<string, string> = {};
  for (const root of roots) topModules[root.name] = root.module;
  const operations: FormRpcOperation[] = schema.operations
    .filter((operation): operation is CompiledOperation & { kind: "rpc" | "action" } => operation.kind !== "notification")
    .map(operation => {
    const scopeInput = operation.kind === "rpc" ? "rpc-input" : "action-input";
    const scopeOutput = operation.kind === "rpc" ? "rpc-output" : "action-output";
    const inputRoot = { scope: scopeInput, parentPath: `${operation.path}/input`, keyNames: new Set<string>() } as const;
    const outputRoot = { scope: scopeOutput, parentPath: `${operation.path}/output`, keyNames: new Set<string>() } as const;
    const inputFields: FormField[] = [];
    const outputFields: FormField[] = [];
    walkFields(schema, operation.input, inputRoot, { constraints: [], readOnly: false }, inputFields, choices);
    walkFields(schema, operation.output, outputRoot, { constraints: [], readOnly: false }, outputFields, choices);
    fields.push(...inputFields, ...outputFields);
    const description = childOf(operation.source, "description")?.argument;
    return {
      kind: operation.kind, name: operation.name, module: operation.module, label: operation.name,
      ...(description ? { help: description } : {}),
      hasInput: childrenOf(operation.source, "input").length > 0,
      hasOutput: childrenOf(operation.source, "output").length > 0,
      inputFields, outputFields, source: operation.source,
    };
  });
  return {
    module: options.module ?? roots[0]?.module ?? "",
    fields, operations, choices,
    ...(options.module ? {} : { topModules }),
    completeness: "type-validation-with-pending-yang-constraints",
  };
}

function isCompiledSchema(input: CompiledYangSchema | YangModule): input is CompiledYangSchema {
  return (input as Partial<CompiledYangSchema>).roots !== undefined && (input as Partial<CompiledYangSchema>).operations !== undefined;
}

/** Compile a raw module (with its import closure) so the form model walks compiled nodes (§87). */
function schemaOfModule(module: YangModule, options: FormModelOptions): CompiledYangSchema {
  const seen = new Set<string>();
  const modules = [module, ...(options.modules ?? [])].filter(candidate => {
    const name = candidate.argument ?? "";
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  const moduleSet: YangModuleSet = { roots: [module], modules, submodules: [], diagnostics: [] };
  return compileYangModules(moduleSet, {});
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



interface EffectiveIntervalConstraint { expression: string; minimum: bigint; maximum: bigint; }
function inheritedIntervals(
  expressions: readonly string[], minimum: bigint, maximum: bigint, decimalDigits?: number,
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
  // The caller passes base-most first so derived restrictions narrow them.
  for (const expression of expressions) {
    constraints.push({ expression, minimum: inheritedMinimum, maximum: inheritedMaximum });
    const parseable = (endpoint: string): boolean => endpoint === "min" || endpoint === "max"
      || (decimalDigits === undefined ? /^[+-]?\d+$/.test(endpoint) : decimalScaled(endpoint, decimalDigits) !== undefined);
    const intervals = expression.split("|").map(part => {
      // RFC 7950 range syntax allows whitespace around the ".." separator.
      const [lowText = "", highText] = part.trim().split("..");
      const highTrimmed = (highText ?? lowText).trim();
      return [parse(lowText.trim()), parse(highTrimmed)] as const;
    });
    // An unparsable endpoint is invalid syntax (RFC 7950 §9.2.4): the
    // expression's garbage must not widen the inherited bounds for the next
    // derived restriction.
    if (intervals.some((interval, index) => {
      const endpoints = expression.split("|")[index]!.trim().split("..");
      return endpoints.some(endpoint => !parseable(endpoint.trim()));
    })) {
      constraints.push({ expression, minimum: inheritedMinimum, maximum: inheritedMaximum });
      continue;
    }
    const lows = intervals.map(interval => interval[0]).filter((value): value is bigint => value !== undefined);
    const highs = intervals.map(interval => interval[1]).filter((value): value is bigint => value !== undefined);
    if (lows.length) inheritedMinimum = lows.reduce((a, b) => a < b ? a : b);
    if (highs.length) inheritedMaximum = highs.reduce((a, b) => a > b ? a : b);
  }
  return constraints;
}
function inIntervals(value: bigint, expression: string, decimalDigits?: number, bounds?: readonly [bigint, bigint]): boolean {
  return expression.split("|").some(part => {
    const [lowText = "", highText] = part.trim().split("..");
    const low = lowText.trim();
    const high = (highText ?? low).trim();
    const parse = (endpoint: string): bigint | undefined => {
      if (endpoint === "min") return bounds?.[0];
      if (endpoint === "max") return bounds?.[1];
      return decimalDigits === undefined ? (/^[+-]?\d+$/.test(endpoint) ? BigInt(endpoint) : undefined) : decimalScaled(endpoint, decimalDigits);
    };
    // An endpoint that is neither min/max nor parseable for the scale makes
    // the interval unusable: it matches nothing (fail closed) instead of
    // standing for unbounded and silently satisfying every value.
    if ((low !== "min" && low !== "max" && parse(low) === undefined)
      || (high !== "min" && high !== "max" && parse(high) === undefined)) {
      return false;
    }
    const lo = parse(low);
    const hi = parse(high);
    return (lo === undefined || value >= lo) && (hi === undefined || value <= hi);
  });
}

function validateType(field: FormField, value: unknown, errors: FormError[]): boolean | undefined {
  if (field.unresolvedType || (field.control === "unsupported" && field.yangType !== "union")) return undefined;
  if (field.yangType === "union") {
    const members = field.restrictions.unionMembers ?? [];
    if (!members.length) return undefined;
    let indeterminate = false;
    for (const member of members) {
      const candidate: FormField = {
        ...field, yangType: member.name, control: member.control,
        options: member.options, unresolvedType: member.unresolved, restrictions: member.restrictions,
      };
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
    for (const constraint of inheritedIntervals([...field.restrictions.lengths].reverse(), 0n, (1n << 64n) - 1n)) {
      if (!inIntervals(BigInt(octets), constraint.expression, undefined, [constraint.minimum, constraint.maximum])) {
        errors.push({ code: "constraint.length", message: `${field.label} has a decoded length outside ${constraint.expression} octets.` }); return false;
      }
    }
    return true;
  }
  if (field.yangType === "string") {
    if (typeof value !== "string") { errors.push({ code: "type.string", message: `${field.label} must be text.` }); return false; }
    const length = BigInt([...value].length);
    for (const constraint of inheritedIntervals([...field.restrictions.lengths].reverse(), 0n, (1n << 64n) - 1n)) {
      if (!inIntervals(length, constraint.expression, undefined, [constraint.minimum, constraint.maximum])) { errors.push({ code: "constraint.length", message: `${field.label} has a length outside ${constraint.expression}.` }); return false; }
    }
    if (typeof value === "string") {
      for (const patternRestriction of field.restrictions.patterns) {
        // RFC 7950 section 9.4.6.2: `modifier invert-match` inverts the
        // satisfaction of this one pattern (not the whole conjunction).
        const invert = patternRestriction.invertMatch;
        const pattern = compileXsdPattern(patternRestriction.expression);
        if (!pattern) continue; // pending patterns surface through unsupportedPattern
        const matched = pattern.test(value);
        if (invert ? matched : !matched) {
          errors.push({ code: "constraint.pattern", message: invert
            ? `${field.label} matches the forbidden pattern '${patternRestriction.expression}'.`
            : `${field.label} does not match pattern '${patternRestriction.expression}'.` });
          return false;
        }
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
    for (const constraint of inheritedIntervals([...field.restrictions.ranges].reverse(), minimum, maximum)) {
      if (!inIntervals(integer, constraint.expression, undefined, [constraint.minimum, constraint.maximum])) { errors.push({ code: "constraint.range", message: `${field.label} must be within ${constraint.expression}.` }); return false; }
    }
    return true;
  }
  if (field.yangType === "decimal64") {
    const digits = field.restrictions.fractionDigits;
    if (digits === undefined || digits < 1 || digits > 18 || typeof value !== "string" && typeof value !== "number") {
      errors.push({ code: "type.decimal64", message: `${field.label} must be a decimal value.` }); return false;
    }
    const scaled = decimalScaled(String(value), digits);
    if (scaled === undefined) { errors.push({ code: "type.decimal64.precision", message: `${field.label} supports at most ${digits} fractional digits.` }); return false; }
    if (scaled < -(1n << 63n) || scaled > (1n << 63n) - 1n) {
      errors.push({ code: "constraint.decimal64.range", message: `${field.label} is outside the decimal64 range for ${digits} fraction digits.` }); return false;
    }
    const decimalMinimum = -(1n << 63n);
    const decimalMaximum = (1n << 63n) - 1n;
    for (const constraint of inheritedIntervals([...field.restrictions.ranges].reverse(), decimalMinimum, decimalMaximum, digits)) {
      if (!inIntervals(scaled, constraint.expression, digits, [constraint.minimum, constraint.maximum])) { errors.push({ code: "constraint.range", message: `${field.label} must be within ${constraint.expression}.` }); return false; }
    }
    return true;
  }
  return undefined;
}

// The parsed type chain surfaces through the field's serializable restriction
// descriptor; copies and proxies keep validating.

/** Validate requiredness and the built-in type/restrictions we can evaluate safely. */
export function validateFormValue(
  field: FormField,
  value: unknown,
  crossReference?: FormCrossReference,
): FormValidationResult {
  const errors: FormError[] = [];
  if (absent(value)) {
    // §87: a mandatory leaf inside a choice case is required only while its
    // case is the active one; choice exclusivity is the UI's/validator's call
    // (model.choices carries the cases' mandatory field paths).
    if (field.required && field.casePath === undefined) errors.push({ code: "required", message: `${field.label} is required.` });
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
  const hasPattern = field.restrictions.patterns.length > 0;
  const unsupportedPattern = hasPattern && (field.yangType !== "string"
    || field.restrictions.patterns.some(patternRestriction => !compileXsdPattern(patternRestriction.expression)));
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
  if (field.multiple) {
    // Leaf-lists of leafref/identityref: every entry is checked against the
    // cross-reference context (RFC 7950 §9.10, §9.9).
    if (!Array.isArray(value)) {
      errors.push({ code: "type.array", message: `${field.label} must be a list of values.` });
      return false;
    }
    let pending = false;
    value.forEach((item, index) => {
      const before = errors.length;
      const verdict = validateCrossReference({ ...field, multiple: false }, item, errors, crossReference);
      if (verdict) pending = true;
      else for (const failure of errors.slice(before)) failure.message = `${failure.message} (entry ${index + 1})`;
    });
    return pending;
  }
  return validateSingleCrossReference(field, value, errors, crossReference);
}

function validateSingleCrossReference(field: FormField, value: unknown, errors: FormError[], crossReference: FormCrossReference): boolean {
  if (field.yangType !== "leafref" && field.yangType !== "identityref") return false;
  if (field.yangType === "leafref") {
    if (!crossReference.anchor) return true;
    const schemaNode = findSchemaNodeByPath(crossReference.schema, field.path);
    if (schemaNode?.resolvedType !== "leafref") return true;
    const text = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
    if (text === undefined || text === "") { errors.push({ code: "type.leafref", message: `${field.label} must be a node reference.` }); return false; }
    // Evaluate the declared path against the anchor element but match it
    // against the submitted value: unlike tree validation, the form value is
    // not committed to the element yet. The path may be declared through the
    // typedef chain (e.g. if:interface-ref), not only on the node's type.
    const pathArgument = leafrefPathStatementOf(schemaNode)?.argument;
    if (!pathArgument) return true;
    const compiled = compileModuleExpression(crossReference.schema, schemaNode.module, pathArgument, schemaNode.declaredIn ?? schemaNode.module);
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
  // ("module:name"), XML-prefixed (resolved through the anchor element's
  // in-scope xmlns bindings, RFC 7950 §9.10.4) or plain identity names.
  const bases = field.restrictions.bases
    .map(base => resolveBaseRef(base, field.module, crossReference.schema))
    .filter((base): base is string => Boolean(base));
  if (!bases.length) return true;
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) { errors.push({ code: "type.identityref", message: `${field.label} must name an identity.` }); return false; }
  const derived = bases.some(base => matchesIdentityBase(crossReference.schema, text, base, crossReference.anchor));
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

function matchesIdentityBase(schema: CompiledYangSchema, value: string, base: string, anchor?: Element): boolean {
  if (value.includes(":")) {
    // XML-prefixed values (RFC 7950 §9.10.4) resolve only through the anchor's
    // in-scope bindings; when the prefix is bound the qualified name decides.
    // Otherwise the value may still be a module-qualified name.
    const qualified = xmlQualifiedIdentity(schema, value, anchor);
    if (qualified) return qualified === base || isIdentityDerivedFrom(schema, qualified, base);
    return value === base || isIdentityDerivedFrom(schema, value, base);
  }
  return schema.identities.some(identity =>
    identity.name === value
    && (identity.module === base.slice(0, base.indexOf(":")) || isIdentityDerivedFrom(schema, `${identity.module}:${identity.name}`, base)));
}

/**
 * Resolve an XML-prefixed identityref value to "module:name" through the
 * anchor element's in-scope xmlns bindings (RFC 7950 §9.10.4). Returns
 * undefined when there is no anchor, the prefix is unbound (or bound to a
 * namespace outside the schema) — leaving other resolution paths to try.
 */
function xmlQualifiedIdentity(schema: CompiledYangSchema, value: string, anchor?: Element): string | undefined {
  if (!anchor || !value.includes(":")) return undefined;
  const separator = value.indexOf(":");
  const namespace = xmlNamespaceForPrefix(anchor, value.slice(0, separator));
  if (!namespace) return undefined;
  const owner = schema.modules.find(module => childOf(module, "namespace")?.argument === namespace);
  return owner ? `${owner.argument}:${value.slice(separator + 1)}` : undefined;
}

/**
 * RFC 6991 canonical lexical representation of a form value for its field's
 * type: integers drop sign padding and leading zeros, decimal64 re-renders
 * with exactly its `fraction-digits`, boolean normalizes JavaScript booleans,
 * bits re-join the selection ordered by bit position, and binary strips
 * insignificant base64 whitespace. Returns `undefined` when the value is not
 * a valid lexical form for the type or the type has no canonical check here
 * (leafref needs its target context; identityref and instance-identifier
 * intentionally have no canonical form under RFC 7950 §§9.10.4/9.13.3).
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
      // RFC 7950 gives identityref and instance-identifier no canonical form.
      // A leafref's form is its target leaf's canonical form, which requires
      // instance-tree context this field-only helper does not carry.
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
  return field.restrictions.fractionDigits !== undefined ? String(field.restrictions.fractionDigits) : undefined;
}

/** RFC 6991 canonical bits order: ascending bit position, declaration order as the default position. */
function sortByBitPosition(field: FormField, selected: string[]): string[] {
  const positions = new Map(field.restrictions.bits.map(bit => [bit.name, bit.position] as const));
  return selected.slice().sort((left, right) => (positions.get(left) ?? 0) - (positions.get(right) ?? 0));
}
