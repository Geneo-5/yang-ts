import { XPathFunction, XPathResult } from "xpath";
import { YangModule, YangStatement } from "../yang/ast.js";
import { childOf, childrenOf } from "../yang/parser.js";
import { CompiledSchemaNode, CompiledYangSchema, isIdentityDerivedFrom, moduleNamespacePrefixes } from "../yang/compiler.js";
import { schemaNodeForElement } from "./accessible-tree.js";
import { compileYangXPath } from "./xpath.js";
import { compileXsdPattern } from "../types/xsd-pattern.js";

/**
 * Follow a leafref statement from its instance element: evaluate the leafref
 * path (prefixes of the declaring module) and keep reached leaves whose value
 * matches the leafref value, so only the referenced node survives. Returns
 * undefined when the node is not a leafref or cannot be resolved.
 */
export type LeafrefResolver = (schemaNode: CompiledSchemaNode, element: Element) => Element[] | undefined;

/**
 * RFC 7950 section 9.9: the effective leafref `path` may live on the node's
 * own `type` statement (direct or deviation-replaced) or on a `leafref` type
 * inside the typedef chain (e.g. ietf-interfaces' if:interface-ref). Shared by
 * the resolver and form-level cross-reference checks.
 */
export function leafrefPathStatementOf(schemaNode: CompiledSchemaNode): YangStatement | undefined {
  if (schemaNode.resolvedType !== "leafref") return undefined;
  const layers = [schemaNode.type, ...schemaNode.typedefChain.map(typedef => childOf(typedef, "type"))]
    .filter((layer): layer is YangStatement => Boolean(layer));
  for (const layer of layers) {
    if (layer.argument !== "leafref") continue;
    const path = childOf(layer, "path");
    if (path?.argument) return path;
  }
  return undefined;
}

/** Build a leafref resolver sharing one compiled-path cache across deref and validation. */
export function createLeafrefResolver(schema: CompiledYangSchema): LeafrefResolver {
  const compiledCache = new Map<string, ReturnType<typeof compileYangXPath>>();
  return (schemaNode, element) => {
    const pathStatement = leafrefPathStatementOf(schemaNode);
    if (!pathStatement?.argument) return undefined;
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

/** Integer value of an enum member as declared on the node's own enumeration type (RFC 7950 §9.6.4). */
function enumPositionOf(schemaNode: CompiledSchemaNode, name: string): number | undefined {
  const layers = [schemaNode.type, ...schemaNode.typedefChain.map(typedef => childOf(typedef, "type"))]
    .filter((layer): layer is YangStatement => Boolean(layer));
  for (let index = layers.length - 1; index >= 0; index--) {
    const layer = layers[index]!;
    if (layer.argument !== "enumeration") continue;
    const members = childrenOf(layer, "enum");
    const found = members.findIndex(member => member.argument === name);
    if (found < 0) continue;
    const value = childOf(members[found]!, "value")?.argument;
    return value !== undefined && /^-?\d+$/.test(value) ? Number(value) : found;
  }
  return undefined;
}

/**
 * XML namespace URI bound to a prefix at the node (including redeclarations on
 * closer ancestors). Walks `xmlns:*` attributes instead of the DOM's
 * lookupNamespaceURI, whose xmldom implementation loses bindings on cloned
 * subtrees — and constraint evaluation evaluates must/when over clones.
 */
export function xmlNamespaceForPrefix(node: Node, prefix: string): string | undefined {
  let current: Node | null = node.nodeType === 1 ? node : node.parentNode;
  while (current && current.nodeType === 1) {
    const attributes = (current as Element).attributes;
    for (let index = 0; attributes && index < attributes.length; index++) {
      const attribute = attributes[index]!;
      if (attribute.name === (prefix ? `xmlns:${prefix}` : "xmlns")) return attribute.value;
    }
    current = current.parentNode;
  }
  return undefined;
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
  const qualifiedValue = (value: string, contextNode?: Node): string | undefined => {
    const separator = value.indexOf(":");
    if (separator < 0) return nativeModule(module) ? `${module}:${value}` : undefined;
    const prefix = value.slice(0, separator);
    const localName = value.slice(separator + 1);
    // RFC 7950 §9.10.4: XML-encoded identityrefs carry XML prefixes bound in
    // the instance document; resolve them through the value node first, then
    // through the expression's prefix map and bare module names.
    const xmlNamespace = contextNode && xmlNamespaceForPrefix(contextNode, prefix);
    if (xmlNamespace) {
      const ownerModule = schema.modules.find(candidate => childOf(candidate, "namespace")?.argument === xmlNamespace);
      if (ownerModule) return `${ownerModule.argument}:${localName}`;
    }
    if (options.prefixModules?.[prefix]) return `${options.prefixModules[prefix]}:${localName}`;
    return nativeModule(prefix) ? value : undefined;
  };
  const positions = collectOptionPositions(schema.modules);
  const resolveLeafref = createLeafrefResolver(schema);
  // Note: `current` cannot live here. RFC 7950 section 10.1 requires the
  // original context node even inside predicates, and the redoable evaluator
  // extends the context per step; the XPath adapter binds it per evaluation.
  const library: Record<string, XFpFunction> = {
    // RFC 7950 section 10.4: every identityref node of the set participates;
    // XML-prefixed values (§9.10.4) qualify through the node's own bindings.
    "derived-from": (context, item, ...bases) => {
      const members = nodeSetMembers(item);
      const baseIds = bases
        .map(base => qualifiedBase(requireString(base, "derived-from")))
        .filter((base): base is string => Boolean(base));
      return members.some(member => {
        if (member.nodeType !== 1) return false;
        const element = member as Element;
        const schemaNode = schemaNodeForElement(schema, element);
        if (schemaNode && schemaNode.resolvedType !== "identityref") return false;
        const value = qualifiedValue(element.textContent ?? "", element);
        return Boolean(value && baseIds.some(base => isIdentityDerivedFrom(schema, value, base)));
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
      const baseIds = bases
        .map(base => qualifiedBase(requireString(base, "derived-from-or-self")))
        .filter((base): base is string => Boolean(base));
      return nodeSetMembers(item).some(member => {
        if (member.nodeType !== 1) return false;
        const element = member as Element;
        const schemaNode = schemaNodeForElement(schema, element);
        if (schemaNode && schemaNode.resolvedType !== "identityref") return false;
        const value = qualifiedValue(element.textContent ?? "", element);
        return Boolean(value && baseIds.some(base => value === base || isIdentityDerivedFrom(schema, value, base)));
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
    // RFC 7950 section 10.5.1: the first node's own enumeration type decides
    // the numeric position; empty sets and non-enum nodes return NaN instead
    // of consulting a schema-wide name table (ambiguous names stay local).
    "enum-value": (context, item) => {
      const target = nodeSetMembers(item)[0];
      if (!target || target.nodeType !== 1) return NaN;
      const schemaNode = schemaNodeForElement(schema, target as Element);
      if (!schemaNode) return NaN;
      return enumPositionOf(schemaNode, (target as Element).textContent ?? "") ?? NaN;
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
