import { CompiledSchemaNode, CompiledYangSchema, moduleNamespacePrefixes } from "../yang/compiler.js";
import { childOf } from "../yang/parser.js";
import { createConstraintEvaluator } from "../xpath/evaluate-constraints.js";
import { createLeafrefResolver } from "../xpath/yang-functions.js";
import { buildAccessibleTree } from "../xpath/accessible-tree.js";

export type ValidationIssueCode =
  | "too-few-elements"
  | "too-many-elements"
  | "missing-key"
  | "duplicate-key"
  | "missing-mandatory"
  | "missing-choice"
  | "unique-violation"
  | "leafref-dangling"
  | "instance-identifier-invalid"
  | "instance-identifier-dangling"
  | "must-unmet"
  | "when-unexpected-node"
  | "cancelled";

export interface ValidationIssue {
  code: ValidationIssueCode;
  /** Schema path of the offending node. */
  path: string;
  message: string;
}

export interface InstanceValidationResult {
  status: "valid" | "invalid" | "indeterminate";
  issues: ValidationIssue[];
}

export interface InstanceValidationOptions {
  /** Default true: state `config false` data participates in validation. */
  includeState?: boolean;
  /**
   * Cooperative cancellation: checked at every element visit; an aborted
   * signal yields a `cancelled` issue and an `indeterminate` status instead of
   * a partial verdict. Interrupting a single XPath mid-expression is not
   * possible in the synchronous evaluator — combine with worker isolation.
   */
  signal?: AbortSignal;
}

/**
 * RFC 7950 structural validation over a whole instance document: list keys,
 * unique, mandatory nodes, min/max-elements, leafref integrity and the
 * compiled `must`/`when` constraint evaluation with three-valued results.
 * Elements outside the effective schema are invisible to the pass. Nodes
 * gated by a `when` whose condition cannot be proven for absent data make the
 * result indeterminate instead of false positives.
 */
export function validateDataTree(
  schema: CompiledYangSchema,
  instance: Document,
  options: InstanceValidationOptions = {},
): InstanceValidationResult {
  const includeState = options.includeState ?? true;
  const evaluator = createConstraintEvaluator(schema);
  const resolveLeafref = createLeafrefResolver(schema);
  const issues: ValidationIssue[] = [];
  let indeterminate = false;
  let cancelled = false;

  const isElement = (node: Node | null): node is Element => node !== null && node.nodeType === 1;
  const issue = (code: ValidationIssueCode, schemaNode: CompiledSchemaNode, message: string): void => {
    issues.push({ code, path: schemaNode.path, message });
  };
  const elementsOf = (element: Element, schemaNode: CompiledSchemaNode): Element[] =>
    Array.from(element.childNodes)
      .filter((child): child is Element =>
        isElement(child) && child.localName === schemaNode.name && child.namespaceURI === schemaNode.namespace);
  const choiceEntries = (element: Element, choice: CompiledSchemaNode): Element[] =>
    choice.children.flatMap(caseNode => caseNode.kind === "case" ? caseNode.children : [caseNode])
      .filter(child => child.kind !== "choice" && child.kind !== "case")
      .flatMap(child => elementsOf(element, child));

  function visitElement(element: Element, schemaNode: CompiledSchemaNode): void {
    if (options.signal?.aborted) { cancelled = true; return; }
    for (const evaluation of evaluator.evaluateNode(element)) {
      if (evaluation.status === "indeterminate") { indeterminate = true; continue; }
      if (evaluation.kind === "must" && evaluation.status === "unmet") {
        issue("must-unmet", schemaNode, `must '${evaluation.expression}' is not satisfied`);
      }
      if (evaluation.kind === "when" && evaluation.status === "unmet") {
        issue("when-unexpected-node", schemaNode, `when '${evaluation.expression}' is false for a present node`);
      }
    }
    for (const child of schemaNode.children) {
      if (child.kind === "choice") {
        // RFC 7950 section 7.9: instance nodes sit directly under the parent,
        // so descent must continue through choice/case. A mandatory leaf
        // inside a case only applies when that case is the active one.
        for (const caseNode of child.children) {
          const members = caseNode.kind === "case" ? caseNode.children : [caseNode];
          const active = members.some(member => member.kind !== "choice" && member.kind !== "case"
            && elementsOf(element, member).length > 0);
          for (const member of members) {
            visitChildNode(element, member, { enforceAbsentRequirements: active });
          }
        }
        if (!choiceEntries(element, child).length && child.properties.mandatory?.[0]?.argument === "true") {
          if (child.whenConstraints.length) { indeterminate = true; continue; }
          issue("missing-choice", child, `choice '${child.name}' requires one case`);
        }
        continue;
      }
      if (child.kind === "case") continue;
      visitChildNode(element, child, { enforceAbsentRequirements: true });
    }
  }

  function visitChildNode(element: Element, child: CompiledSchemaNode, options: { enforceAbsentRequirements: boolean }): void {
    const entries = elementsOf(element, child);
    if (entries.length > 1 && child.kind !== "list" && child.kind !== "leaf-list") {
      issue("too-many-elements", child, `node '${child.path}' may appear at most once, found ${entries.length}`);
    }
    checkCardinality(entries, child);
    if (!entries.length) {
      // A when-gated node cannot be evaluated on absent data: probe it with
      // a placeholder to learn whether its condition would allow absence.
      if (child.whenConstraints.length) {
        const probe = (element.ownerDocument ?? instance).createElementNS(child.namespace, child.name);
        element.appendChild(probe);
        try {
          const statuses = evaluator.evaluateNode(probe).filter(e => e.kind === "when").map(e => e.status);
          if (statuses.every(status => status === "unmet")) return;
          if (statuses.some(status => status === "indeterminate")) { indeterminate = true; return; }
        } finally { element.removeChild(probe); }
      }
      if (options.enforceAbsentRequirements) checkAbsentRequirements(child);
      return;
    }
    if (child.kind === "list") checkList(child, entries);
    for (const entry of entries) visitElement(entry, child);
  }

  function checkCardinality(entries: Element[], child: CompiledSchemaNode): void {
    const min = child.properties["min-elements"]?.[0]?.argument;
    const max = child.properties["max-elements"]?.[0]?.argument;
    if (min !== undefined && entries.length < Number(min)) {
      issue("too-few-elements", child, `'${child.path}' needs at least ${min} entries, found ${entries.length}`);
    }
    if (max !== undefined && entries.length > Number(max)) {
      issue("too-many-elements", child, `'${child.path}' allows at most ${max} entries, found ${entries.length}`);
    }
  }

  function checkAbsentRequirements(child: CompiledSchemaNode): void {
    const mandatory = child.properties.mandatory?.[0]?.argument;
    if (mandatory === "true" && child.kind !== "list" && child.kind !== "leaf-list") {
      issue("missing-mandatory", child, `mandatory node '${child.path}' is absent`);
    }
  }

  function checkList(child: CompiledSchemaNode, entries: Element[]): void {
    const keyNames = (child.properties.key?.[0]?.argument ?? "").split(/\s+/).filter(Boolean);
    const seenKeys = new Set<string>();
    for (const entry of entries) {
      const keyElements = keyNames.map(name =>
        Array.from(entry.childNodes).find(candidate => isElement(candidate)
          && candidate.localName === name && candidate.namespaceURI === child.namespace));
      if (keyNames.length && keyElements.some(key => key === undefined)) {
        issue("missing-key", child, `entry of list '${child.name}' requires keys ${keyNames.join(" ")}`);
      } else {
        const signature = keyElements.map(key => (key as Element).textContent ?? "").join("\u0000");
        if (seenKeys.has(signature)) issue("duplicate-key", child, `duplicate key combination in list '${child.name}'`);
        seenKeys.add(signature);
      }
    }
    checkUnique(child, entries);
  }

  /**
   * RFC 7950 section 7.8.3: each argument of `unique` is a whitespace list of
   * descendant paths; the constraint is violated only when two entries have
   * identical values for ALL referenced leafs, and only entries where every
   * referenced leaf exists participate in the check.
   */
  const uniqueStepsCache = new WeakMap<CompiledSchemaNode, { argument: string; subPaths: { namespace: string | undefined; name: string }[][] }[]>();
  function checkUnique(child: CompiledSchemaNode, entries: Element[]): void {
    const statements = (child.properties.unique ?? []).filter(statement => statement.argument?.trim());
    if (!statements.length) return;
    let parsed = uniqueStepsCache.get(child);
    if (!parsed) {
      const prefixes = moduleNamespacePrefixes(schema, child.module);
      parsed = statements.map(statement => ({
        argument: statement.argument!,
        subPaths: statement.argument!.trim().split(/\s+/).map(subPath => subPath.split("/").map(step => {
          const separator = step.indexOf(":");
          const prefix = separator >= 0 ? step.slice(0, separator) : undefined;
          const name = separator >= 0 ? step.slice(separator + 1) : step;
          return { namespace: prefix !== undefined ? prefixes[prefix] : child.namespace, name };
        })),
      }));
      uniqueStepsCache.set(child, parsed);
    }
    for (const statement of parsed) {
      const seen = new Set<string>();
      for (const entry of entries) {
        const values: string[] = [];
        let complete = true;
        for (const steps of statement.subPaths) {
          let current: Element | undefined = entry;
          for (const step of steps) {
            if (!current) { complete = false; break; }
            current = Array.from(current.childNodes).find(candidate => isElement(candidate)
              && candidate.localName === step.name && candidate.namespaceURI === step.namespace) as Element | undefined;
          }
          if (!current) { complete = false; break; }
          values.push(current.textContent ?? "");
        }
        if (!complete) continue;
        const signature = values.join("\u0000");
        if (seen.has(signature)) {
          issue("unique-violation", child, `unique '${statement.argument}' is violated in list '${child.name}'`);
          break;
        }
        seen.add(signature);
      }
    }
  }

  // require-instance lives on the `type` statement (refine copies land on the node's properties).
  const requireInstanceDisabled = (node: CompiledSchemaNode): boolean =>
    (node.type ? childOf(node.type, "require-instance")?.argument : undefined) === "false"
    || node.properties["require-instance"]?.[0]?.argument === "false";

  function checkLeafrefs(element: Element, schemaNode: CompiledSchemaNode): void {
    if (schemaNode.resolvedType === "leafref" && !requireInstanceDisabled(schemaNode)
      && resolveLeafref(schemaNode, element)?.length === 0) {
      issue("leafref-dangling", schemaNode, `leafref '${schemaNode.path}' does not resolve in the instance`);
    }
    for (const child of schemaNode.children) {
      if (child.kind === "choice" || child.kind === "case") { checkLeafrefs(element, child); continue; }
      for (const entry of elementsOf(element, child)) checkLeafrefs(entry, child);
    }
  }

  function checkInstanceIdentifiers(element: Element, schemaNode: CompiledSchemaNode, store: Document): void {
    if (schemaNode.resolvedType === "instance-identifier" && schemaNode.kind === "leaf") {
      const value = element.textContent ?? "";
      const requireInstance = !requireInstanceDisabled(schemaNode);
      const parsed = parseInstanceIdentifier(value, requireInstance);
      if (!parsed.ok) {
        issue("instance-identifier-invalid", schemaNode, `instance-identifier '${schemaNode.path}' is not a valid instance-identifier: ${parsed.reason}`);
      } else if (requireInstance && !resolvesInstanceIdentifier(store, parsed.steps)) {
        issue("instance-identifier-dangling", schemaNode, `instance-identifier of '${schemaNode.path}' does not resolve in the instance`);
      }
    }
    for (const child of schemaNode.children) {
      if (child.kind === "choice" || child.kind === "case") { checkInstanceIdentifiers(element, child, store); continue; }
      for (const entry of elementsOf(element, child)) checkInstanceIdentifiers(entry, child, store);
    }
  }

  // Validate the accessible tree (RFC 7950 §6.4.1) instead of the raw document:
  // defaults are injected and `config false` state data is hidden in the config
  // context, so mandatory, unique, leafref and must/when semantics match the
  // datastore being checked. Every matching root becomes its own datastore
  // document, keeping absolute-path anchors at the data root.
  const rawTop = instance.documentElement;
  if (!rawTop) return { status: indeterminate ? "indeterminate" : "valid", issues };
  if (options.signal?.aborted) cancelled = true;
  for (const root of schema.roots) {
    if (root.kind === "choice" || root.kind === "case") continue;
    if (!includeState && !root.config) continue;
    if (cancelled) break;
    const present = rawTop.localName === root.name && rawTop.namespaceURI === root.namespace ? [rawTop] : elementsOf(rawTop, root);
    for (const entry of present) {
      const holder = instance.implementation.createDocument(null, "", null);
      holder.appendChild(holder.importNode(entry, true));
      const accessible = buildAccessibleTree(schema, holder, { context: includeState ? "datastore-state" : "datastore-config" });
      const dataRoot = accessible.document.documentElement!;
      checkLeafrefs(dataRoot, root);
      checkInstanceIdentifiers(dataRoot, root, accessible.document);
      visitElement(dataRoot, root);
    }
  }
  // Cancellation replaces the verdict: a partial tree walk says nothing about
  // the whole instance, so the status is indeterminate and `cancelled` says why.
  return cancelled
    ? { status: "indeterminate", issues: [...issues, { code: "cancelled", path: "/", message: "Validation was cancelled before completion." }] }
    : { status: issues.length ? "invalid" : indeterminate ? "indeterminate" : "valid", issues };
}

/** One node step of an RFC 7950 instance-identifier (section 9.13): a node
 *  name plus key/value predicates; a `.` predicate key addresses leaf-lists. */
interface IdentifierStep {
  name: string;
  predicates: { key: string; value: string }[];
}

type ParsedIdentifier =
  | { ok: true; steps: IdentifierStep[] }
  | { ok: false; reason: string };

type ParsedStep =
  | { ok: true; step: IdentifierStep }
  | { ok: false; reason: string };

/**
 * Parse the instance-identifier lexical form: a root-anchored path of node
 * names with `[key = value]` or `[. = value]` predicates. Namespace prefixes
 * are optional and match instance elements by local name. Values may be
 * quoted; unquoted values stop at path/predicate delimiters. With
 * `require-instance false` any non-empty XPath expression is accepted.
 */
function parseInstanceIdentifier(value: string, requireInstance: boolean): ParsedIdentifier {
  if (!requireInstance) {
    return value.trim().length > 0 ? { ok: true, steps: [] } : { ok: false, reason: "empty expression" };
  }
  if (!value.startsWith("/")) return { ok: false, reason: "must start with '/'" };
  const segments = splitTopLevel(value);
  if (!segments) return { ok: false, reason: "unbalanced brackets or quotes" };
  const steps: IdentifierStep[] = [];
  for (const segment of segments.slice(1)) {
    const parsed = parseStep(segment);
    if (!parsed.ok) return parsed;
    steps.push(parsed.step);
  }
  if (!steps.length) return { ok: false, reason: "path has no node steps" };
  return { ok: true, steps };
}

/** Split on `/` outside brackets and quotes, keeping empty head before the leading slash. */
function splitTopLevel(value: string): string[] | undefined {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (const ch of value) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === "[") { depth++; current += ch; continue; }
    if (ch === "]") { depth--; if (depth < 0) return undefined; current += ch; continue; }
    if (ch === "/" && depth === 0) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  if (quote || depth !== 0) return undefined;
  parts.push(current);
  return parts;
}

function parseStep(segment: string): ParsedStep {
  const bracketStart = segment.indexOf("[");
  const name = bracketStart >= 0 ? segment.slice(0, bracketStart) : segment;
  const localName = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
  if (!/^[\w.-]+$/.test(localName)) return { ok: false, reason: `invalid node name '${name}'` };
  const predicates: { key: string; value: string }[] = [];
  let rest = segment.slice(localName.length).replace(/^[^[]*/, "");
  while (rest.length) {
    if (!rest.startsWith("[")) return { ok: false, reason: `malformed predicate in '${segment}'` };
    const end = closingBracket(rest);
    if (end < 0) return { ok: false, reason: "unbalanced brackets" };
    const predicate = parsePredicate(rest.slice(1, end));
    if (!predicate.ok) return predicate;
    predicates.push(predicate.keyValue);
    rest = rest.slice(end + 1);
  }
  return { ok: true, step: { name: localName, predicates } };
}

/** Index (within a string starting at `[`) of the matching `]`, honoring quotes. */
function closingBracket(text: string): number {
  let quote: string | null = null;
  for (let index = 1; index < text.length; index++) {
    const ch = text[index]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "]") return index;
  }
  return -1;
}

type ParsedPredicate =
  | { ok: true; keyValue: { key: string; value: string } }
  | { ok: false; reason: string };

function parsePredicate(text: string): ParsedPredicate {
  const match = text.match(
    /^\s*(?:[\w.-]+:)?([\w.-]+|\.)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^"'[\]/]*)\s*$/,
  );
  if (!match) return { ok: false, reason: `malformed predicate '[${text}]'` };
  const raw = match[2] ?? "";
  const quoted = raw.length > 1 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")));
  const value = quoted ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw.trim();
  return { ok: true, keyValue: { key: match[1]!, value } };
}

/** Resolve parsed steps against the instance document, local names only. */
function resolvesInstanceIdentifier(instance: Document, steps: IdentifierStep[]): boolean {
  let current: Element | undefined = instance.documentElement;
  if (!current) return false;
  const first = steps[0]!;
  if (current.localName !== first.name) return false;
  if (!matchPredicates(current, first.predicates)) return false;
  for (const step of steps.slice(1)) {
    const next = Array.from(current.childNodes).find(child => child.nodeType === 1 &&
      (child as Element).localName === step.name) as Element | undefined;
    if (!next) return false;
    current = next;
    if (!current) return false;
    if (!matchPredicates(current, step.predicates)) return false;
  }
  return true;
}

function matchPredicates(element: Element, predicates: { key: string; value: string }[]): boolean {
  // A list entry identifier must carry all of the entry's keys; a bare node
  // without predicates matches any entry.
  for (const predicate of predicates) {
    if (predicate.key === ".") {
      if ((element.textContent ?? "") !== predicate.value) return false;
      continue;
    }
    const key = Array.from(element.childNodes).find(child => child.nodeType === 1 &&
      (child as Element).localName === predicate.key) as Element | undefined;
    if (!key || (key.textContent ?? "") !== predicate.value) return false;
  }
  return true;
}
