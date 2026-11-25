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

/** Standard NMDA datastores from ietf-datastores, or a module-qualified extension identity. */
export type RestconfDatastore = "ietf-datastores:operational" | "ietf-datastores:running" | "ietf-datastores:intended" | (string & {});

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

/** Build a RFC 8527 datastore resource path, optionally followed by a data-node path. */
export function nodeToRestconfDatastorePath(
  datastore: RestconfDatastore,
  path: readonly YangPathSegment[] = [],
  restconfRoot = "/restconf",
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*:[A-Za-z_][A-Za-z0-9_.-]*$/.test(datastore)) {
    throw new Error(`Datastore identity '${datastore}' must be module-qualified`);
  }
  const root = `${pathRoot(restconfRoot)}/ds/${datastore}`;
  if (path.length === 0) return root;
  const dataPath = nodeToRestconfDataPath(path, restconfRoot);
  return `${root}${dataPath.slice(`${pathRoot(restconfRoot)}/data`.length)}`;
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

/** RESTCONF query parameters, including standard parameters and server extensions. */
export type RestconfQueryParameters = Readonly<Record<string, string | number | boolean>>;

function withQuery(path: string, query?: RestconfQueryParameters): string {
  if (!query) return path;
  const parameters: string[] = [];
  for (const [name, value] of Object.entries(query)) {
    if (name === "with-origin") {
      if (value === true) parameters.push("with-origin");
      else if (value !== false) throw new Error("with-origin is a presence-only query parameter; pass true or false");
      continue;
    }
    parameters.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return parameters.length ? `${path}?${parameters.join("&")}` : path;
}

export interface RestconfDataRequest {
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  headers: { Accept: "application/yang-data+json"; "Content-Type"?: "application/yang-data+json" };
  body?: Record<string, unknown>;
}

/** Prepare RFC 8527 datastore operations. HEAD is useful for NMDA capability probing. */
export function createRestconfDatastoreRequest(
  method: RestconfDataRequest["method"],
  datastore: RestconfDatastore,
  path: readonly YangPathSegment[] = [],
  resource?: { module: string; name: string; data: Record<string, unknown> },
  query?: RestconfQueryParameters,
  restconfRoot = "/restconf",
): RestconfDataRequest {
  const target = nodeToRestconfDatastorePath(datastore, path, restconfRoot);
  const hasBodyMethod = method === "POST" || method === "PUT" || method === "PATCH";
  if (hasBodyMethod && !resource) throw new Error(`${method} requires a data resource body`);
  if (!hasBodyMethod && resource) throw new Error(`${method} does not accept a data resource body`);
  if ((method === "PUT" || method === "PATCH" || method === "DELETE") && path.length === 0) {
    throw new Error(`${method} requires a target data resource`);
  }
  if (query?.["with-origin"] === true && method !== "GET") {
    throw new Error("The with-origin query parameter is only valid on GET requests");
  }
  if (query?.["with-origin"] === true && datastore !== "ietf-datastores:operational") {
    throw new Error("The with-origin query parameter requires the operational datastore");
  }
  const body = resource ? dataEnvelope(resource.module, resource.name, resource.data) : undefined;
  return dataRequest(method, withQuery(target, query), body);
}

/** Probe whether a server exposes the mandatory NMDA operational datastore (RFC 8527 §2). */
export function createRestconfNmdaProbeRequest(restconfRoot = "/restconf"): RestconfDataRequest {
  return createRestconfDatastoreRequest("HEAD", "ietf-datastores:operational", [], undefined, undefined, restconfRoot);
}

const DATA_ACCEPT = "application/yang-data+json" as const;
const DATA_CONTENT_TYPE = "application/yang-data+json" as const;

function dataRequest(
  method: RestconfDataRequest["method"],
  path: string,
  body?: Record<string, unknown>,
): RestconfDataRequest {
  const hasBody = body !== undefined;
  return {
    method,
    path,
    headers: { Accept: DATA_ACCEPT, ...(hasBody ? { "Content-Type": DATA_CONTENT_TYPE } : {}) },
    ...(hasBody ? { body } : {}),
  };
}

function dataEnvelope(module: string, name: string, data: Record<string, unknown>): Record<string, unknown> {
  if (!module || !name) throw new Error("A data resource module and name are required");
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("RESTCONF data must be a JSON object");
  return { [`${module}:${name}`]: data };
}

/** Prepare a GET request for a data resource or collection. */
export function createRestconfGetRequest(path: readonly YangPathSegment[] = [], restconfRoot = "/restconf", query?: RestconfQueryParameters): RestconfDataRequest {
  return dataRequest("GET", withQuery(nodeToRestconfDataPath(path, restconfRoot), query));
}

/** Create a child resource by POSTing it to its parent resource (RFC 8040 §4.4.1). */
export function createRestconfAddRequest(
  parentPath: readonly YangPathSegment[],
  resource: { module: string; name: string; data: Record<string, unknown> },
  restconfRoot = "/restconf",
  query?: RestconfQueryParameters,
): RestconfDataRequest {
  return dataRequest("POST", withQuery(nodeToRestconfDataPath(parentPath, restconfRoot), query), dataEnvelope(resource.module, resource.name, resource.data));
}

/** Delete the target data resource (RFC 8040 §4.7). */
export function createRestconfDeleteRequest(path: readonly YangPathSegment[], restconfRoot = "/restconf", query?: RestconfQueryParameters): RestconfDataRequest {
  if (path.length === 0) throw new Error("DELETE requires a target data resource");
  return dataRequest("DELETE", withQuery(nodeToRestconfDataPath(path, restconfRoot), query));
}

/** Create or replace the target data resource using PUT (RFC 8040 §4.5). */
export function createRestconfSetRequest(
  path: readonly YangPathSegment[],
  resource: { module: string; name: string; data: Record<string, unknown> },
  restconfRoot = "/restconf",
  query?: RestconfQueryParameters,
): RestconfDataRequest {
  if (path.length === 0) throw new Error("PUT requires a target data resource");
  return dataRequest("PUT", withQuery(nodeToRestconfDataPath(path, restconfRoot), query), dataEnvelope(resource.module, resource.name, resource.data));
}

/**
 * Merge supplied nodes into an existing data resource using plain PATCH.
 * RESTCONF POST creates a child resource; PATCH is the partial update method.
 */
export function createRestconfUpdateRequest(
  path: readonly YangPathSegment[],
  resource: { module: string; name: string; data: Record<string, unknown> },
  restconfRoot = "/restconf",
  query?: RestconfQueryParameters,
): RestconfDataRequest {
  if (path.length === 0) throw new Error("PATCH requires a target data resource");
  return dataRequest("PATCH", withQuery(nodeToRestconfDataPath(path, restconfRoot), query), dataEnvelope(resource.module, resource.name, resource.data));
}

/** Extract one module-qualified node from a RESTCONF JSON response body. */
export function readRestconfData(response: unknown, module: string, name: string): unknown {
  if (!response || typeof response !== "object" || Array.isArray(response)) return undefined;
  return (response as Record<string, unknown>)[`${module}:${name}`];
}

/** Prepare an RFC 8040 JSON RPC request body; it does not send the request. */
export function createRestconfRpcRequest(
  operation: FormRpcOperation,
  input?: Record<string, unknown>,
  restconfRoot = "/restconf",
  query?: RestconfQueryParameters,
): RestconfRpcRequest {
  if (!operation.hasInput && input !== undefined) throw new Error(`RPC '${operation.name}' has no input statement`);
  const body = operation.hasInput && input !== undefined ? { [`${operation.module}:input`]: input } : undefined;
  return {
    method: "POST",
    path: withQuery(restconfRpcPath(operation, restconfRoot), query),
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
