import type { CompiledSchemaNode, CompiledYangSchema } from "../yang/compiler.js";
import type { YangModule, YangStatement } from "../yang/ast.js";
import { childOf } from "../yang/parser.js";
import { matchSchemaChild } from "../xpath/accessible-tree.js";

/**
 * RFC 7951 (JSON encoding of YANG data) ↔ XML instance trees.
 *
 * RESTCONF speaks RFC 7951 (`application/yang-data+json`) while the engine's
 * validation, candidate evaluation and constraint evaluation run on XML
 * instance documents. This adapter bridges the two so a JSON response can be
 * decoded into a document, validated/prefilled, and written back.
 *
 * Encoding rules implemented (RFC 7951 §4–§6): member names are
 * module-qualified only at namespace changes (the document root is always
 * qualified), int64/uint64/decimal64 stay strings, `empty` is `[null]`,
 * `bits` are space-separated strings, identityref values are qualified with
 * the module that defines the identity, and instance-identifier strings are
 * encoded with namespace declarations derived from RFC 7951 module-name
 * prefixes; `anydata`/`anyxml` content converts
 * structurally, without schema knowledge (best effort).
 */

export class YangJsonError extends Error {
  constructor(message: string, readonly path: string) {
    super(path ? `${message} (at ${path})` : message);
    this.name = "YangJsonError";
  }
}

export interface YangJsonToDocumentOptions {
  /** An almost-empty Document whose documentElement the adapter replaces. */
  document: Document;
}

interface ModuleInfo { name: string; namespace: string; prefix: string }

function moduleInfos(schema: CompiledYangSchema): {
  byName: Map<string, ModuleInfo>;
  byNamespace: Map<string, ModuleInfo>;
} {
  const byName = new Map<string, ModuleInfo>();
  const byNamespace = new Map<string, ModuleInfo>();
  for (const module of schema.modules as readonly YangModule[]) {
    const namespace = childOf(module, "namespace")?.argument ?? "";
    const prefix = childOf(module, "prefix")?.argument ?? "";
    const info: ModuleInfo = { name: module.argument, namespace, prefix };
    byName.set(module.argument, info);
    if (namespace) byNamespace.set(namespace, info);
  }
  for (const submodule of schema.submodules as readonly YangStatement[]) {
    void submodule;
  }
  return { byName, byNamespace };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** RFC 7951 64-bit and decimal64 values must be strings. */
const NUMBER_TYPES: ReadonlySet<string> = new Set(["int8", "int16", "int32", "uint8", "uint16", "uint32"]);

const splitMemberKey = (key: string): { module: string | undefined; localName: string } => {
  const colon = key.indexOf(":");
  if (colon <= 0 || colon === key.length - 1) return { module: undefined, localName: key };
  return { module: key.slice(0, colon), localName: key.slice(colon + 1) };
};

function fail(message: string, path: string): never {
  throw new YangJsonError(message, path);
}

/* ------------------------------------------------------------------ */
/* JSON → XML                                                          */
/* ------------------------------------------------------------------ */

/**
 * Decode an RFC 7951 JSON body into an XML instance document for the
 * existing validation/candidate/prefill pipeline. The JSON must carry
 * exactly one top-level data node (a RESTCONF resource body); validate
 * resource by resource otherwise. `options.document` supplies the DOM
 * implementation (the engine ships without one); its documentElement is
 * replaced by the built root. Throws `YangJsonError` with the JSON path of
 * the offending member for unknown or malformed shapes.
 */
export function yangJsonToDocument(
  schema: CompiledYangSchema,
  json: unknown,
  options: YangJsonToDocumentOptions,
): Document {
  const modules = moduleInfos(schema);
  const target = options.document;
  if (!isPlainObject(json)) fail("expected an RFC 7951 JSON object of data resource members", "");
  const members = Object.keys(json);
  if (members.length !== 1) {
    fail(`expected exactly one top-level data node, got ${members.length}`, members.join(", "));
  }
  const key = members[0]!;
  const { module, localName } = splitMemberKey(key);
  const roots = schema.roots.filter(node => node.name === localName && (
    module === undefined ? true : modules.byName.get(module)?.namespace === node.namespace
  ));
  if (roots.length === 0) fail(`unknown top-level data node '${key}'`, key);
  if (roots.length > 1) fail(`ambiguous top-level data node '${key}' — qualify it with the module name`, key);
  const schemaNode = roots[0]!;
  const element = target.createElementNS(schemaNode.namespace, localName);
  if (target.documentElement) target.replaceChild(element, target.documentElement);
  else target.appendChild(element);
  buildValue(schema, schemaNode, json[key], element, false, modules, `/${localName}`);
  return target;
}

/** Schema children flattened across choice/case (RFC 7951 encodes case members as container members). */
function dataChildrenOf(node: CompiledSchemaNode): CompiledSchemaNode[] {
  return node.children.flatMap(child =>
    child.kind === "choice" || child.kind === "case" ? dataChildrenOf(child) : [child]);
}

function resolveMember(
  parent: CompiledSchemaNode,
  key: string,
  modules: ReturnType<typeof moduleInfos>,
  path: string,
): CompiledSchemaNode {
  const { module, localName } = splitMemberKey(key);
  const candidates = dataChildrenOf(parent).filter(node => node.name === localName && (
    module === undefined ? node.namespace === parent.namespace
      : node.namespace === modules.byName.get(module)?.namespace
  ));
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) fail(`unknown data node '${key}' under '${parent.name}'`, path);
  fail(`ambiguous member '${key}' under '${parent.name}'`, path);
}

/**
 * Build one data node. `attach = true`: the node creates its own element
 * under `parent`. `attach = false` (root calls and list entries): `parent`
 * already IS the node's element and gets filled. Lists and leaf-lists have
 * no wrapper element of their own — their entries are direct children of
 * the parent element (RFC 7950 XML encoding).
 */
function buildValue(
  schema: CompiledYangSchema,
  schemaNode: CompiledSchemaNode,
  value: unknown,
  parent: Element,
  attach: boolean,
  modules: ReturnType<typeof moduleInfos>,
  path: string,
): void {
  const doc = parent.ownerDocument;
  if (schemaNode.kind === "list") {
    if (!Array.isArray(value)) fail(`expected an array of list entries for '${schemaNode.name}'`, path);
    for (const [index, entry] of value.entries()) {
      const entryPath = `${path}[${index}]`;
      if (!isPlainObject(entry)) fail(`expected an object for a list entry of '${schemaNode.name}'`, entryPath);
      const item = attach
        ? doc.createElementNS(schemaNode.namespace, schemaNode.name)
        : (index === 0 ? parent : fail(`a document root list entry carries exactly one entry`, path));
      if (attach) parent.appendChild(item);
      for (const key of Object.keys(entry)) {
        const child = resolveMember(schemaNode, key, modules, `${entryPath}/${key}`);
        buildValue(schema, child, entry[key], item, true, modules, `${entryPath}/${key}`);
      }
    }
    return;
  }
  if (schemaNode.kind === "leaf-list") {
    if (!Array.isArray(value)) fail(`expected an array for leaf-list '${schemaNode.name}'`, path);
    for (const item of value) {
      const itemElement = doc.createElementNS(schemaNode.namespace, schemaNode.name);
      parent.appendChild(itemElement);
      itemElement.textContent = scalarText(schemaNode, item, path);
    }
    return;
  }
  const own = attach ? doc.createElementNS(schemaNode.namespace, schemaNode.name) : parent;
  if (attach) parent.appendChild(own);
  switch (schemaNode.kind) {
    case "container": {
      if (!isPlainObject(value)) fail(`expected an object for container '${schemaNode.name}'`, path);
      for (const key of Object.keys(value)) {
        const child = resolveMember(schemaNode, key, modules, `${path}/${key}`);
        buildValue(schema, child, value[key], own, true, modules, `${path}/${key}`);
      }
      return;
    }
    case "leaf": {
      // RFC 7951 §6.9: the value of an empty leaf is the single-element
      // array [null]; it maps to an element without content.
      if (schemaNode.resolvedType === "empty") {
        if (!Array.isArray(value) || value.length !== 1 || value[0] !== null) {
          fail(`expected [null] for empty leaf '${schemaNode.name}'`, path);
        }
        return;
      }
      own.textContent = schemaNode.resolvedType === "instance-identifier"
        ? instanceIdentifierText(value, modules, own, path)
        : identityrefText(schemaNode, value, modules, own, path);
      return;
    }
    case "anydata":
    case "anyxml": {
      for (const node of anyValueToNodes(value, schemaNode.namespace, schemaNode.name, doc, path)) {
        own.appendChild(node);
      }
      return;
    }
    default:
      fail(`schema node kind '${schemaNode.kind}' carries no JSON value`, path);
  }
}

/**
 * identityref JSON values are `module:name` (RFC 7951 §6.8); XML content is
 * prefix-qualified with a namespace declaration in scope, so translate the
 * module name to the module's own prefix and declare it on the value element.
 */
function identityrefText(
  schemaNode: CompiledSchemaNode,
  value: unknown,
  modules: ReturnType<typeof moduleInfos>,
  element: Element,
  path: string,
): string {
  if (schemaNode.resolvedType !== "identityref" || typeof value !== "string") {
    return scalarText(schemaNode, value, path);
  }
  const { module, localName } = splitMemberKey(value);
  const info = module ? modules.byName.get(module) : undefined;
  if (info?.prefix) {
    element.setAttributeNS("http://www.w3.org/2000/xmlns/", `xmlns:${info.prefix}`, info.namespace);
    return `${info.prefix}:${localName}`;
  }
  return value;
}

/** Translate RFC 7951 module-name prefixes into in-scope XML namespace prefixes. */
function instanceIdentifierText(
  value: unknown,
  modules: ReturnType<typeof moduleInfos>,
  element: Element,
  path: string,
): string {
  if (typeof value !== "string") fail("expected a string for instance-identifier", path);
  const text = value;
  return text.replace(/(^|\/|\[|\s)([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)(?=\s*(?:\[|=|\/|$))/g,
    (token, boundary: string, moduleName: string, localName: string) => {
      const info = modules.byName.get(moduleName);
      if (!info?.prefix) return token;
      element.setAttributeNS("http://www.w3.org/2000/xmlns/", `xmlns:${info.prefix}`, info.namespace);
      return `${boundary}${info.prefix}:${localName}`;
    });
}

function scalarText(schemaNode: CompiledSchemaNode, value: unknown, path: string): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`non-finite number for '${schemaNode.name}'`, path);
    return String(value);
  }
  if (typeof value === "string") return value;
  fail(`unexpected ${typeof value} value for leaf '${schemaNode.name}'`, path);
}

/** anydata/anyxml content from plain JSON data (best effort): objects and arrays nest, scalars become text. */
function anyValueToNodes(value: unknown, namespace: string, name: string, doc: Document, path: string): Element[] {
  if (Array.isArray(value)) {
    return value.flatMap(item => anyValueToNodes(item, namespace, name, doc, path));
  }
  const element = doc.createElementNS(namespace, name);
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      const { localName } = splitMemberKey(key);
      // No schema here: qualified member names flatten into the anydata's own
      // namespace (documented best effort).
      for (const node of anyValueToNodes(value[key], namespace, localName, doc, `${path}/${key}`)) {
        element.appendChild(node);
      }
    }
    return [element];
  }
  element.textContent = scalarText(
    { kind: "leaf", name } as unknown as CompiledSchemaNode,
    value,
    path,
  );
  return [element];
}

/* ------------------------------------------------------------------ */
/* XML → JSON                                                          */
/* ------------------------------------------------------------------ */

function childElements(element: Element): Element[] {
  const out: Element[] = [];
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const node = element.childNodes[index]!;
    if (node.nodeType === 1) out.push(node as Element);
  }
  return out;
}

function inScopeNamespaces(element: Element): Map<string, string> {
  const prefixes = new Map<string, string>();
  for (let node: Node | null = element; node && node.nodeType === 1; node = node.parentNode) {
    const holder = node as Element;
    const attributes = holder.attributes;
    for (let index = 0; index < attributes.length; index += 1) {
      const attribute = attributes.item(index)!;
      if (attribute.name === "xmlns") prefixes.set("", attribute.value);
      else if (attribute.name.startsWith("xmlns:")) {
        prefixes.set(attribute.name.slice("xmlns:".length), attribute.value);
      }
    }
  }
  return prefixes;
}

/** instance-identifier text: rewrite `prefix:name` tokens to `module:name` (best effort; RFC 7951 §6.8 keeps the rest verbatim). */
function rewriteInstanceIdentifier(
  text: string,
  namespaces: Map<string, string>,
  modules: ReturnType<typeof moduleInfos>,
): string {
  return text.split("/").map(segment => {
    const predicate = /^\[.*\]$/.exec(segment);
    const bare = predicate ? segment.slice(1, -1) : segment;
    const colon = bare.indexOf(":");
    if (colon <= 0) return segment;
    const namespace = namespaces.get(bare.slice(0, colon));
    if (!namespace) return segment;
    const moduleName = modules.byNamespace.get(namespace)?.name ?? bare.slice(0, colon);
    const rewritten = `${moduleName}:${bare.slice(colon + 1)}`;
    return predicate ? `[${rewritten}]` : rewritten;
  }).join("/");
}

function encodeScalar(
  schema: CompiledYangSchema,
  schemaNode: CompiledSchemaNode,
  element: Element,
  modules: ReturnType<typeof moduleInfos>,
): unknown {
  const text = element.textContent ?? "";
  if (NUMBER_TYPES.has(schemaNode.resolvedType ?? "")) {
    const value = Number(text);
    return Number.isNaN(value) ? text : value;
  }
  switch (schemaNode.resolvedType) {
    case "boolean":
      if (text === "true" || text === "false") return text === "true";
      return text;
    case "empty":
      return [null];
    case "identityref": {
      const colon = text.indexOf(":");
      const namespaces = inScopeNamespaces(element);
      if (colon <= 0) {
        // Unprefixed: the identity lives in the leaf's own namespace.
        const identity = schema.identities.find(candidate =>
          candidate.name === text && candidate.namespace === schemaNode.namespace);
        return identity ? `${identity.module}:${text}` : text;
      }
      const namespace = namespaces.get(text.slice(0, colon));
      if (namespace) {
        const identity = schema.identities.find(candidate =>
          candidate.name === text.slice(colon + 1) && candidate.namespace === namespace);
        if (identity) return `${identity.module}:${text.slice(colon + 1)}`;
      }
      return text;
    }
    case "instance-identifier":
      return rewriteInstanceIdentifier(text, inScopeNamespaces(element), modules);
    default:
      // int64/uint64/decimal64 and every other builtin keep the text form.
      return text;
  }
}

function memberKey(
  schemaNode: CompiledSchemaNode,
  containingNamespace: string,
  modules: ReturnType<typeof moduleInfos>,
  alwaysQualified: boolean,
): string {
  if (alwaysQualified || schemaNode.namespace !== containingNamespace) {
    const moduleName = modules.byNamespace.get(schemaNode.namespace)?.name;
    return moduleName ? `${moduleName}:${schemaNode.name}` : schemaNode.name;
  }
  return schemaNode.name;
}

/**
 * Encode an XML instance document as an RFC 7951 JSON body: one top-level
 * member for the document root (always module-qualified), the §4–§6 rules in
 * reverse. Elements without a schema node raise `YangJsonError` — encode
 * what the schema knows, never guess.
 */
export function documentToYangJson(schema: CompiledYangSchema, doc: Document): Record<string, unknown> {
  const modules = moduleInfos(schema);
  const root = doc.documentElement;
  if (!root) fail("the document has no root element", "");
  const rootNode = matchSchemaChild(schema.roots, root);
  if (!rootNode) fail(`unknown top-level data node '${root.nodeName}'`, `/${root.localName ?? root.nodeName}`);
  return {
    [memberKey(rootNode, rootNode.namespace, modules, true)]:
      encodeNode(schema, root, rootNode, modules, `/${rootNode.name}`),
  };
}

function encodeNode(
  schema: CompiledYangSchema,
  element: Element,
  schemaNode: CompiledSchemaNode,
  modules: ReturnType<typeof moduleInfos>,
  path: string,
): unknown {
  switch (schemaNode.kind) {
    case "container":
      return encodeMembers(schema, element, schemaNode, modules, path);
    case "leaf":
      return encodeScalar(schema, schemaNode, element, modules);
    case "anydata":
    case "anyxml":
      return anyElementToValue(element, element.namespaceURI ?? "");
    default:
      fail(`schema node kind '${schemaNode.kind}' carries no XML value`, path);
  }
}

/** Encode the members of a container element or one list entry; the containing namespace is the parent schema node's own (RFC 7951 §5.4). */
function encodeMembers(
  schema: CompiledYangSchema,
  element: Element,
  schemaNode: CompiledSchemaNode,
  modules: ReturnType<typeof moduleInfos>,
  path: string,
): Record<string, unknown> {
  const members: Record<string, unknown> = {};
  for (const child of childElements(element)) {
    const node = matchSchemaChild(schemaNode.children, child);
    if (!node) fail(`unknown data node '${child.nodeName}' under '${schemaNode.name}'`, `${path}/${child.localName ?? child.nodeName}`);
    const key = memberKey(node, schemaNode.namespace, modules, false);
    const childPath = `${path}/${node.name}`;
    if (node.kind === "list") {
      const list = (members[key] as unknown[] | undefined) ?? [];
      list.push(encodeMembers(schema, child, node, modules, childPath));
      members[key] = list;
    } else if (node.kind === "leaf-list") {
      const list = (members[key] as unknown[] | undefined) ?? [];
      list.push(encodeScalar(schema, node, child, modules));
      members[key] = list;
    } else {
      members[key] = encodeNode(schema, child, node, modules, childPath);
    }
  }
  return members;
}

/** anydata/anyxml content (best effort): childless → text string, children → plain JSON keyed by local name, repeated names become arrays. */
function anyElementToValue(element: Element, containingNamespace: string): unknown {
  const children = childElements(element);
  if (children.length === 0) return element.textContent ?? "";
  const result: Record<string, unknown> = {};
  for (const child of children) {
    const key = child.localName ?? child.nodeName;
    const value = anyElementToValue(child, child.namespaceURI ?? containingNamespace);
    if (key in result) {
      const existing = result[key];
      result[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      result[key] = value;
    }
  }
  return result;
}
