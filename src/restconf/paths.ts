import { YangModule } from "../yang/ast.js";
import { childOf, childrenOf } from "../yang/parser.js";
import { FormRpcOperation } from "../forms/form-model.js";

export type RestconfScalar = string | number | bigint | boolean;
export interface YangPathKey { name: string; value: RestconfScalar }
export interface YangPathSegment {
  /** YANG identifier. */
  name: string;
  /** Module that defines this data node. */
  module: string;
  /** List keys in the order declared by the YANG key statement. */
  keys?: readonly YangPathKey[];
  /** Leaf-list instance value, when this segment identifies one instance. */
  leafListValue?: RestconfScalar;
}

function xpathPrefix(context: YangModule, targetModule: string): string {
  if (targetModule === context.argument) {
    const prefix = childOf(context, "prefix")?.argument;
    if (!prefix) throw new Error(`Module '${context.argument}' has no prefix statement`);
    return prefix;
  }
  const imported = childrenOf(context, "import").find(item => item.argument === targetModule);
  const prefix = imported && childOf(imported, "prefix")?.argument;
  if (!prefix) throw new Error(`Module '${targetModule}' is not imported into XPath context '${context.argument}'`);
  return prefix;
}

function xpathString(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  const pieces = value.split("'");
  const args: string[] = [];
  pieces.forEach((piece, index) => {
    args.push(`'${piece}'`);
    if (index < pieces.length - 1) args.push(`"'"`);
  });
  return `concat(${args.join(",")})`;
}

/** Convert a schema-node path to an absolute YANG XPath expression. */
export function nodeToXPath(contextModule: YangModule, path: readonly YangPathSegment[]): string {
  if (path.length === 0) return "/";
  return path.map(segment => {
    const prefix = xpathPrefix(contextModule, segment.module);
    const name = `${prefix}:${segment.name}`;
    let result = name;
    for (const key of segment.keys ?? []) {
      result += `[${prefix}:${key.name}=${xpathString(String(key.value))}]`;
    }
    if (segment.leafListValue !== undefined) result += `[.=${xpathString(String(segment.leafListValue))}]`;
    return result;
  }).reduce((expression, segment) => `${expression}/${segment}`, "");
}

function pathRoot(root: string): string { return `/${root.replace(/^\/+|\/+$/g, "")}`; }
function encodeKeyValue(value: RestconfScalar): string {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Convert schema/data path segments to an RFC 8040 data resource URI path.
 * This is a RESTCONF URI, not an XPath expression.
 */
export function nodeToRestconfDataPath(path: readonly YangPathSegment[], restconfRoot = "/restconf"): string {
  if (path.length === 0) return `${pathRoot(restconfRoot)}/data`;
  let previousModule: string | undefined;
  const encoded = path.map(segment => {
    const qualifiedName = previousModule === segment.module ? segment.name : `${segment.module}:${segment.name}`;
    previousModule = segment.module;
    let resource = qualifiedName;
    if (segment.keys) {
      if (segment.keys.length === 0) throw new Error(`List '${segment.name}' has no key values`);
      resource += `=${segment.keys.map(key => encodeKeyValue(key.value)).join(",")}`;
    }
    if (segment.leafListValue !== undefined) resource += `=${encodeKeyValue(segment.leafListValue)}`;
    return resource;
  });
  return `${pathRoot(restconfRoot)}/data/${encoded.join("/")}`;
}

/** RFC 8040 operation resource for a YANG rpc statement. */
export function restconfRpcPath(operation: Pick<FormRpcOperation, "module" | "name">, restconfRoot = "/restconf"): string {
  return `${pathRoot(restconfRoot)}/operations/${operation.module}:${operation.name}`;
}

export interface RestconfRpcRequest {
  method: "POST";
  path: string;
  headers: { "Content-Type": "application/yang-data+json"; Accept: "application/yang-data+json" };
  body?: Record<string, unknown>;
}

/** Prepare an RFC 8040 JSON RPC request body; it does not send the request. */
export function createRestconfRpcRequest(
  operation: FormRpcOperation,
  input?: Record<string, unknown>,
  restconfRoot = "/restconf",
): RestconfRpcRequest {
  if (!operation.hasInput && input !== undefined) throw new Error(`RPC '${operation.name}' has no input statement`);
  const body = operation.hasInput && input !== undefined ? { [`${operation.module}:input`]: input } : undefined;
  return {
    method: "POST",
    path: restconfRpcPath(operation, restconfRoot),
    headers: { "Content-Type": "application/yang-data+json", Accept: "application/yang-data+json" },
    ...(body ? { body } : {}),
  };
}

/** Extract the RFC 8040 JSON output wrapper from a successful RPC response. */
export function readRestconfRpcOutput(operation: FormRpcOperation, response: unknown): Record<string, unknown> | undefined {
  if (!operation.hasOutput) return undefined;
  if (!response || typeof response !== "object" || Array.isArray(response)) return undefined;
  const wrapper = (response as Record<string, unknown>)[`${operation.module}:output`];
  return wrapper && typeof wrapper === "object" && !Array.isArray(wrapper) ? wrapper as Record<string, unknown> : undefined;
}
