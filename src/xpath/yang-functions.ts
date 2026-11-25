import { XPathFunction } from "xpath";
import { YangModule, YangStatement } from "../yang/ast.js";
import { childOf, childrenOf } from "../yang/parser.js";
import { CompiledYangSchema, isIdentityDerivedFrom } from "../yang/compiler.js";

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

interface Argument {
  stringValue(): string;
}

const requireString = (value: Argument | undefined, name: string): string => {
  if (!value) throw new Error(`Function ${name} is missing an argument`);
  return value.stringValue();
};

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

type XFpFunction = (context: { contextNode: Node }, ...args: Argument[]) => string | number | boolean | Node;

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
