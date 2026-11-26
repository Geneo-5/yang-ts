import { CompiledSchemaNode, CompiledYangSchema } from "../yang/compiler.js";

/**
 * RFC 7950 section 6.4.1 accessible trees. Datastore contexts differ only in
 * whether `config false` state nodes stay visible; operation and notification
 * contexts are fictional trees holding just the operation node and its scope.
 */
export type AccessibleTreeContext =
  | "datastore-config"
  | "datastore-state"
  | "notification"
  | "rpc-input"
  | "rpc-output"
  | "action-input"
  | "action-output";

export interface AccessibleTreeOptions {
  context: AccessibleTreeContext;
  /** Operation or notification name for non-datastore contexts, optionally `module:name`. */
  operation?: string;
}

export interface AccessibleTree {
  document: Document;
  /** RFC 7950 section 6.4.1 context node for the requested context: the datastore document for datastore contexts, the operation/notification node otherwise. */
  contextNode: Node;
}

const OPERATION_CONTEXTS: ReadonlySet<AccessibleTreeContext> = new Set([
  "rpc-input", "rpc-output", "action-input", "action-output",
]);

/**
 * Build the accessible tree for evaluating `must`/`when` expressions against
 * instance data. Instance elements that do not match the effective schema are
 * dropped; missing leaves and leaf-lists with declared defaults are injected in
 * datastore contexts so expressions see with-defaults content.
 */
export function buildAccessibleTree(
  schema: CompiledYangSchema,
  instance: Document,
  options: AccessibleTreeOptions,
): AccessibleTree {
  if (options.context !== "datastore-config" && options.context !== "datastore-state" && !options.operation) {
    throw new Error(`Operation context '${options.context}' requires an operation name`);
  }
  const document = instance.implementation.createDocument(null, "", null);
  if (options.context === "datastore-config" || options.context === "datastore-state") {
    const scope = { includeState: options.context === "datastore-state", defaults: true };
    // Schema roots match the instance document element itself, not its children.
    // The data root becomes the document element and the context node is the
    // datastore document (RFC 6.4.1 virtual root): relative paths reach the
    // data root (deref(pool/chosen)) while absolute /module:root/... paths see
    // the data root as the top-level node, matching real instance documents.
    const top = instance.documentElement!;
    let contextNode: Element | undefined;
    for (const rootNode of schema.roots) {
      if (rootNode.kind === "choice" || rootNode.kind === "case") continue;
      if (!scope.includeState && !rootNode.config) continue;
      if (top.localName !== rootNode.name || top.namespaceURI !== rootNode.namespace) continue;
      contextNode = accessibleDataRoot(rootNode, top, scope, document);
      document.appendChild(contextNode);
    }
    if (!contextNode) throw new Error(`Instance root <${top.localName}> does not match any root of the compiled schema`);
    return { document, contextNode: document };
  }
  const separator = options.operation!.indexOf(":");
  const moduleFilter = separator >= 0 ? options.operation!.slice(0, separator) : undefined;
  const nameFilter = separator >= 0 ? options.operation!.slice(separator + 1) : options.operation!;
  const requestedKind = options.context === "notification" ? "notification"
    : options.context.startsWith("rpc-") ? "rpc" : "action";
  const operation = schema.operations.find(candidate =>
    candidate.name === nameFilter && candidate.kind === requestedKind
    && (moduleFilter === undefined || candidate.module === moduleFilter));
  if (!operation) throw new Error(`No ${requestedKind} operation '${options.operation}' in the compiled schema`);
  const wrapper = document.createElement(operation.name);
  const scopeNodes = options.context === "notification" ? operation.data
    : options.context.endsWith("-input") ? operation.input : operation.output;
  copyScope(scopeNodes, instance.documentElement!, wrapper, { includeState: true, defaults: false }, document);
  return { document, contextNode: wrapper };
}

function isElement(node: Node | null): node is Element {
  return node !== null && node.nodeType === 1;
}

function matchingElements(parent: Element, namespace: string, name: string): Element[] {
  return Array.from(parent.childNodes).filter((child): child is Element =>
    isElement(child) && child.localName === name && child.namespaceURI === namespace);
}

interface ScopeOptions { includeState: boolean; defaults: boolean }

const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";

/**
 * Re-declare the source element's xmlns bindings on its accessible-tree copy.
 * Rebuilt elements carry no attributes, but XML-prefixed identityref values
 * (RFC 7950 section 9.10.4) resolve through these bindings — must/when
 * evaluation runs against this tree, so prefixes would otherwise become
 * unresolvable.
 */
function copyNamespaceDeclarations(source: Element, copy: Element): void {
  const attributes = source.attributes;
  for (let index = 0; attributes && index < attributes.length; index++) {
    const attribute = attributes[index]!;
    if (attribute.name === "xmlns" || attribute.name.startsWith("xmlns:")) {
      // The XMLNS namespace makes xmldom update the element's namespace map
      // (setAttribute alone binds nothing for lookups).
      copy.setAttributeNS(XMLNS_NAMESPACE, attribute.name, attribute.value);
    }
  }
}

/**
 * Accessible copy of one data root: the root element with the schema-visible
 * content copied under `scope` (state filter, with-defaults injection). Used
 * by buildAccessibleTree and by whole-datastore validation passes.
 */
export function accessibleDataRoot(rootNode: CompiledSchemaNode, source: Element, scope: ScopeOptions, document: Document): Element {
  const copy = document.createElementNS(rootNode.namespace, rootNode.name);
  copyNamespaceDeclarations(source, copy);
  copyScope(rootNode.children, source, copy, scope, document);
  return copy;
}

/**
 * Copy the schema-node slice of `source` visible under `target`. Choice and
 * case wrappers are schema structure only; instance data sits directly under
 * the real parent, so recursion descends through them transparently.
 */
function copyScope(nodes: readonly CompiledSchemaNode[], source: Element, target: Element, scope: ScopeOptions, document: Document): void {
  for (const node of nodes) {
    if (node.kind === "choice" || node.kind === "case") {
      copyScope(node.children, source, target, scope, document);
      continue;
    }
    if (!scope.includeState && !node.config) continue;
    const present = matchingElements(source, node.namespace, node.name);
    for (const element of present) {
      const copy = document.createElementNS(node.namespace, node.name);
      copyNamespaceDeclarations(element, copy);
      if (node.kind === "leaf" || node.kind === "leaf-list") copy.textContent = element.textContent;
      else copyScope(node.children, element, copy, scope, document);
      target.appendChild(copy);
    }
    if (scope.defaults) applyDefaults(node, present.length, target, document);
  }
}

/** RFC 7950 sections 7.6.4 and 7.7.5: declared defaults apply only in datastore contexts when no value is present. */
function applyDefaults(node: CompiledSchemaNode, present: number, target: Element, document: Document): void {
  const values = node.kind === "leaf" && present === 0
    ? (node.properties.default?.[0]?.argument !== undefined ? [node.properties.default[0]!.argument] : [])
    : node.kind === "leaf-list" && present === 0
      ? (node.properties.default ?? []).map(value => value.argument).filter((value): value is string => value !== undefined)
      : [];
  for (const value of values) {
    const copy = document.createElementNS(node.namespace, node.name);
    copy.textContent = value;
    target.appendChild(copy);
  }
}

export function matchSchemaChild(nodes: readonly CompiledSchemaNode[], element: Element): CompiledSchemaNode | undefined {
  for (const node of nodes) {
    if (node.kind === "choice" || node.kind === "case") {
      const nested = matchSchemaChild(node.children, element);
      if (nested) return nested;
      continue;
    }
    if (node.name === element.localName && node.namespace === element.namespaceURI) return node;
  }
  return undefined;
}

/**
 * Map an instance element (for example inside a datastore accessible tree) to
 * its compiled schema node by walking namespace/name segments from the root.
 * Built trees sit under a synthetic wrapper whose children are schema roots.
 */
export function schemaNodeForElement(schema: CompiledYangSchema, element: Element): CompiledSchemaNode | undefined {
  // Walk the element chain up to the document root, then trim ancestors that
  // are not schema roots: built accessible trees carry a synthetic wrapper
  // above their root copies, while raw instance documents name their root
  // data node directly as the document element.
  const segment = (node: Element): Element[] => {
    const parent = node.parentNode;
    return isElement(parent) ? [...segment(parent), node] : [node];
  };
  const chain = segment(element);
  const rootIndex = chain.findIndex(segmentElement => schema.roots.some(root =>
    root.name === segmentElement.localName && root.namespace === segmentElement.namespaceURI));
  if (rootIndex < 0) return undefined;
  let schemaNode = schema.roots.find(root =>
    root.name === chain[rootIndex]!.localName && root.namespace === chain[rootIndex]!.namespaceURI)!;
  for (const child of chain.slice(rootIndex + 1)) {
    const next = matchSchemaChild(schemaNode.children, child);
    if (!next) return undefined;
    schemaNode = next;
  }
  return schemaNode;
}

/** Schema-tree children with choice/case indirections removed: members hang at the instance level. */
export function flattenDataChildren(nodes: readonly CompiledSchemaNode[]): CompiledSchemaNode[] {
  return nodes.flatMap(node => node.kind === "choice"
    ? flattenDataChildren(node.children)
    : node.kind === "case" ? node.children : [node]);
}

/**
 * Resolve a bare schema path ("/top/list/leaf") to its compiled schema node.
 * Choice and case names are transparent to schema paths — a segment may name
 * the choice/case itself (as the compiler's `path` values do) — and list
 * segments tolerate the form-model's `[*]` (or `[key='v']`) predicates.
 */
export function findSchemaNodeByPath(schema: CompiledYangSchema, path: string): CompiledSchemaNode | undefined {
  const chain = schemaNodeChainByPath(schema, path);
  return chain ? chain[chain.length - 1] : undefined;
}

/**
 * Schema nodes matched segment by segment for a bare schema path, exactly as
 * `findSchemaNodeByPath` resolves them but keeping every intermediate match:
 * choice/case segments contribute their kind, data segments their instance
 * namespaces. Instance navigation (e.g. candidate evaluation) uses this to
 * namespace-check each ancestor independently.
 */
export function schemaNodeChainByPath(schema: CompiledYangSchema, path: string): CompiledSchemaNode[] | undefined {
  const parts = path.split("/").filter(Boolean).map(part => part.replace(/\[[^\]]*\]/g, ""));
  let level: readonly CompiledSchemaNode[] = schema.roots;
  const chain: CompiledSchemaNode[] = [];
  for (const part of parts) {
    const flat = flattenDataChildren(level);
    // Data node names win over a colliding choice/case segment name.
    const found = flat.find(node => node.name === part)
      ?? level.find(node => (node.kind === "choice" || node.kind === "case") && node.name === part);
    if (!found) return undefined;
    chain.push(found);
    level = found.children;
  }
  return chain;
}
