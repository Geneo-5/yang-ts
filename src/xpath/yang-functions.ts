import { XPathFunction, XPathResult } from "xpath";
import { YangModule, YangStatement } from "../yang/ast.js";
import { childOf, childrenOf } from "../yang/parser.js";
import { CompiledSchemaNode, CompiledYangSchema, isIdentityDerivedFrom, moduleNamespacePrefixes } from "../yang/compiler.js";
import { schemaNodeForElement } from "./accessible-tree.js";
import { compileYangXPath } from "./xpath.js";

/**
 * Follow a leafref statement from its instance element: evaluate the leafref
 * path (prefixes of the declaring module) and keep reached leaves whose value
 * matches the leafref value, so only the referenced node survives. Returns
 * undefined when the node is not a leafref or cannot be resolved.
 */
export type LeafrefResolver = (schemaNode: CompiledSchemaNode, element: Element) => Element[] | undefined;

/** Build a leafref resolver sharing one compiled-path cache across deref and validation. */
export function createLeafrefResolver(schema: CompiledYangSchema): LeafrefResolver {
  const compiledCache = new Map<string, ReturnType<typeof compileYangXPath>>();
  return (schemaNode, element) => {
    const pathStatement = schemaNode.type && childOf(schemaNode.type, "path");
    if (schemaNode.resolvedType !== "leafref" || !pathStatement?.argument) return undefined;
    const owner = schema.modules.find(module => module.argument === schemaNode.module);
    if (!owner) return undefined;
    const key = schemaNode.module + ":" + pathStatement.argument;
    let compiled = compiledCache.get(key);
    if (compiled === undefined) {
      // Leafref paths use the declaring module's prefixes, including its own
      // (RFC 7950 §6.4.1); without it `ov:clock/ov:time` cannot resolve.
      compiled = compileYangXPath(
        pathStatement.argument,
        childOf(owner, "namespace")?.argument ?? "",
        moduleNamespacePrefixes(schema, schemaNode.module),
      );
      compiledCache.set(key, compiled);
    }
    const value = element.textContent ?? "";
    return compiled.select({ node: element })
      .filter((child): child is Element => child.nodeType === 1 && (child as unknown as Element).textContent === value);
  };
}

/** Namespace the RFC 7950 section 10 function library is registered under as well as unprefixed. */
export const YANG_FUNCTION_NAMESPACE = "urn:ietf:params:xml:ns:yang:1";

export interface YangXPathFunctionOptions {
  /** Compiled schema providing the identity/enum/bit definitions the functions consult. */
  schema: CompiledYangSchema;
  /** Module whose namespace resolves unprefixed identity names, per RFC 7950 section 10. */
  module: string;
  /** XPath prefix to module-name mapping, so prefixed base identities resolve per RFC 7950 section 14. */
  prefixModules?: Readonly<Record<string, string>>;
}

type Argument = XPathResult;

/** Custom-function signature matching the evaluator's runtime behavior. */
type XFpFunction = (context: { contextNode: Node }, ...args: Argument[]) => string | number | boolean | Node | Node[] | Argument;

const requireString = (value: Argument | undefined, name: string): string => {
  if (!value) throw new Error(`Function ${name} is missing an argument`);
  return value.stringValue();
};

/** Extract element members from a node-set argument, whatever wrapper the evaluator supplies. */
function nodeSetMembers(item: Argument | undefined): Node[] {
  if (!item) throw new Error("Function is missing an argument");
  const set = item as unknown as { toArray?: () => Node[]; first?: () => Node | null };
  if (typeof set.toArray === "function") return set.toArray();
  if (typeof set.first === "function") return [set.first()!].filter(Boolean);
  return [];
}

/** Build the RFC 7950 section 10 function library for evaluation against compiled schemas. */
export function createYangFunctionLibrary(options: YangXPathFunctionOptions): Record<string, XPathFunction> {
  const { schema, module } = options;
  const nativeModule = (name: string) => schema.modules.find(candidate => candidate.argument === name);
  const qualifiedBase = (base: string): string | undefined => {
    const separator = base.indexOf(":");
    const [prefixOrModule, localName] = separator < 0 ? [module, base] : [base.slice(0, separator), base.slice(separator + 1)];
    const resolvedName = separator < 0 ? prefixOrModule! : options.prefixModules?.[prefixOrModule!] ?? prefixOrModule!;
    return nativeModule(resolvedName) ? `${resolvedName}:${localName}` : undefined;
  };
  const qualifiedValue = (value: string): string | undefined => {
    const separator = value.indexOf(":");
    if (separator >= 0) return nativeModule(value.slice(0, separator)) ? value : undefined;
    return nativeModule(module) ? `${module}:${value}` : undefined;
  };
  const positions = collectOptionPositions(schema.modules);
  const resolveLeafref = createLeafrefResolver(schema);
  // Note: `current` cannot live here. RFC 7950 section 10.1 requires the
  // original context node even inside predicates, and the redoable evaluator
  // extends the context per step; the XPath adapter binds it per evaluation.
  const library: Record<string, XFpFunction> = {
    // RFC 7950 section 10.4.
    "derived-from": (context, item, ...bases) => {
      const value = qualifiedValue(requireString(item, "derived-from"));
      if (!value) return false;
      return bases.some(base => {
        const baseId = qualifiedBase(requireString(base, "derived-from"));
        return Boolean(baseId && isIdentityDerivedFrom(schema, value, baseId));
      });
    },
    // RFC 7950 section 10.5: follow leafref paths from built accessible trees.
    deref: (context, item) => {
      const nodes = nodeSetMembers(item);
      if (!nodes.length) throw new Error("deref requires a non-empty node set");
      const target = nodes[0]!;
      if (target.nodeType !== 1) return item;
      const schemaNode = schemaNodeForElement(schema, target as Element);
      if (!schemaNode) return item;
      const resolved = resolveLeafref(schemaNode, target as Element);
      return resolved ?? item;
    },
    "derived-from-or-self": (context, item, ...bases) => {
      const value = qualifiedValue(requireString(item, "derived-from-or-self"));
      if (!value) return false;
      return bases.some(base => {
        const baseId = qualifiedBase(requireString(base, "derived-from-or-self"));
        return Boolean(baseId && (value === baseId || isIdentityDerivedFrom(schema, value, baseId)));
      });
    },
    // RFC 7950 section 10.6. Patterns are implicitly anchored XML Schema regexes.
    "re-match": (context, item, pattern) => {
      const value = requireString(item, "re-match");
      const source = requireString(pattern, "re-match");
      const compiled = compileXsdPattern(source);
      if (!compiled) throw new Error(`re-match pattern '${source}' is not a supported XML Schema regular expression`);
      return compiled.test(value);
    },
    // RFC 7950 section 10.8: the numeric position of the item's enum value.
    "enum-value": (context, item) => {
      const name = requireString(item, "enum-value");
      const position = positions.enums.get(name);
      if (typeof position !== "number") throw new Error(`enum-value: enum '${name}' is not uniquely defined in the compiled schema`);
      return position;
    },
    // RFC 7950 section 10.9.
    "bit-is-set": (context, bits, bit) => {
      const value = requireString(bits, "bit-is-set");
      const name = requireString(bit, "bit-is-set");
      if (!positions.bits.has(name)) throw new Error(`bit-is-set: bit '${name}' is not uniquely defined in the compiled schema`);
      return value.split(/\s+/).includes(name);
    },
  };
  // The evaluator's map resolver keys functions by local name only, so both
  // `current()` and `yang:current(...)` reach the same implementation.
  const registered: Record<string, XPathFunction> = {};
  for (const [name, implementation] of Object.entries(library)) registered[name] = implementation;
  return registered;
}

/** Compile an XML Schema pattern to an anchored JavaScript regex over the shared subset. */
const xsdPatternCache = new Map<string, RegExp | undefined>();
function compileXsdPattern(pattern: string): RegExp | undefined {
  const cached = xsdPatternCache.get(pattern);
  if (cached !== undefined) return cached;
  if (xsdPatternCache.has(pattern)) return undefined;
  let compiled: RegExp | undefined;
  if (!/\\\d|\(\?/.test(pattern) && !hasCharacterClassSubtraction(pattern)) {
    try { compiled = new RegExp(`^(?:${pattern})$`); } catch { compiled = undefined; }
  }
  xsdPatternCache.set(pattern, compiled);
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

interface OptionPositions {
  enums: ReadonlyMap<string, number | "ambiguous">;
  bits: ReadonlyMap<string, number | "ambiguous">;
}

/** Map option names to declared positions; conflicting declarations across typedefs stay ambiguous. */
function collectOptionPositions(modules: readonly YangModule[]): OptionPositions {
  const enums = new Map<string, number | "ambiguous">();
  const bits = new Map<string, number | "ambiguous">();
  let currentMap: Map<string, number | "ambiguous"> | undefined;
  let defaultPosition = 0;
  const visit = (statement: YangStatement): void => {
    if (statement.keyword === "enum" || statement.keyword === "bit") {
      const map = currentMap!;
      const positionStatement = childOf(statement, statement.keyword === "enum" ? "value" : "position");
      const position = positionStatement?.argument !== undefined && /^-?\d+$/.test(positionStatement.argument)
        ? Number(positionStatement.argument) : defaultPosition;
      const existing = map.get(statement.argument ?? "");
      map.set(statement.argument ?? "", existing === undefined || existing === position ? position : "ambiguous");
      defaultPosition = position + 1;
      return;
    }
    if (statement.keyword === "type") {
      const kind = statement.argument === "enumeration" ? "enum" : statement.argument === "bits" ? "bit" : undefined;
      if (kind) {
        const optionName = kind === "enum" ? "enum" : "bit";
        currentMap = kind === "enum" ? enums : bits;
        defaultPosition = 0;
        childrenOf(statement, optionName).forEach(visit);
        currentMap = undefined;
        return;
      }
    }
    statement.children.forEach(visit);
  };
  modules.forEach(module => visit(module));
  return { enums, bits };
}
