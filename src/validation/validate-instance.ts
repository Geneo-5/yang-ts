import { CompiledSchemaNode, CompiledYangSchema, documentNamespacePrefixes } from "../yang/compiler.js";
import { childOf } from "../yang/parser.js";
import { createConstraintEvaluator } from "../xpath/evaluate-constraints.js";
import { createLeafrefResolver, leafrefPathStatementOf } from "../xpath/yang-functions.js";
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
  /**
   * Wall-clock budget in milliseconds over the whole validation (RFC 7950
   * evaluation boundary, not mid-XPath — see `signal`). Exceeding it behaves
   * exactly like an aborted signal: the run stops at the next element and the
   * verdict becomes `indeterminate` with a `cancelled` issue.
   */
  deadlineMs?: number;
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
  const deadline = (options.deadlineMs ?? undefined) === undefined
    ? undefined
    : { startedAt: Date.now(), limit: options.deadlineMs! };
  /** A spent wall-clock budget behaves like an aborted signal at every check. */
  const cancelledNow = (): boolean =>
    Boolean(options.signal?.aborted)
    || (deadline !== undefined && Date.now() - deadline.startedAt >= deadline.limit);
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
  // A choice member may itself be a choice (RFC 7950 §7.9.2): its elements
  // are its nested case members', not an element of its own name.
  const choiceMemberElements = (element: Element, member: CompiledSchemaNode): Element[] =>
    member.kind === "choice" ? choiceEntries(element, member) : elementsOf(element, member);
  const choiceEntries = (element: Element, choice: CompiledSchemaNode): Element[] =>
    choice.children.flatMap(caseNode => caseNode.kind === "case" ? caseNode.children : [caseNode])
      .filter(child => child.kind !== "case")
      .flatMap(child => choiceMemberElements(element, child));

  function visitElement(element: Element, schemaNode: CompiledSchemaNode): void {
    if (cancelledNow()) { cancelled = true; return; }
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
        visitChoiceNodes(element, child, true);
        continue;
      }
      if (child.kind === "case") continue;
      visitChildNode(element, child, { enforceAbsentRequirements: true });
    }
  }

  /**
   * RFC 7950 sections 7.9/7.9.2: choice and case hold no instance data; their
   * members sit directly under the parent element, and a case member may
   * itself be a choice whose cases activate only when the enclosing case does.
   * `enforced` is set when the choice is required to have a case selected: at
   * the top level always, and for a nested choice only when its enclosing
   * case is the active one.
   */
  function visitChoiceNodes(element: Element, choice: CompiledSchemaNode, enforced: boolean): void {
    if (cancelledNow()) { cancelled = true; return; }
    for (const caseNode of choice.children) {
      const members = caseNode.kind === "case" ? caseNode.children : [caseNode];
      const active = members.some(member => choiceMemberElements(element, member).length > 0);
      for (const member of members) {
        visitChildNode(element, member, { enforceAbsentRequirements: active });
      }
    }
    if (enforced && !choiceEntries(element, choice).length && choice.properties.mandatory?.[0]?.argument === "true") {
      if (choice.whenConstraints.length) { indeterminate = true; return; }
      issue("missing-choice", choice, `choice '${choice.name}' requires one case`);
    }
  }

  function visitChildNode(element: Element, child: CompiledSchemaNode, options: { enforceAbsentRequirements: boolean }): void {
    if (child.kind === "choice") {
      // A choice reached through the children walk (nested in a case): its
      // case-exclusivity applies only where its enclosing site is active.
      visitChoiceNodes(element, child, options.enforceAbsentRequirements);
      return;
    }
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
    // RFC 7950 section 7.6.5: a container without `presence` is conceptually
    // always present, so its absence does not lift its descendants' mandatory
    // requirements. A when-gated node may be legitimately absent: leave the
    // verdict to the when probe. A choice reports missing-choice; its case
    // members' own requirements stay dormant while no case is selected.
    if (child.kind === "container" && child.properties.presence === undefined && !child.whenConstraints.length) {
      for (const descendant of child.children) {
        // State nodes are not part of the config datastore's accessible tree:
        // their requirements are unenforceable there.
        if (!includeState && !descendant.config) continue;
        if (descendant.kind === "choice") {
          if (descendant.properties.mandatory?.[0]?.argument === "true") {
            if (descendant.whenConstraints.length) indeterminate = true;
            else issue("missing-choice", descendant, `choice '${descendant.name}' requires one case`);
          }
          continue;
        }
        if (descendant.kind === "case") continue;
        checkAbsentRequirements(descendant);
      }
    }
  }

  function checkList(child: CompiledSchemaNode, entries: Element[]): void {
    const keyNames = (child.properties.key?.[0]?.argument ?? "").split(/\s+/).filter(Boolean);
    const seenKeys = new Set<string>();
    if (keyNames.length) {
      for (const entry of entries) {
        const keyElements = keyNames.map(name =>
          Array.from(entry.childNodes).find(candidate => isElement(candidate)
            && candidate.localName === name && candidate.namespaceURI === child.namespace));
        if (keyElements.some(key => key === undefined)) {
          issue("missing-key", child, `entry of list '${child.name}' requires keys ${keyNames.join(" ")}`);
        } else {
          const signature = keyElements.map(key => (key as Element).textContent ?? "").join("\u0000");
          if (seenKeys.has(signature)) issue("duplicate-key", child, `duplicate key combination in list '${child.name}'`);
          seenKeys.add(signature);
        }
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
      const prefixes = documentNamespacePrefixes(schema, child.declaredIn || child.module);
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
    if (schemaNode.resolvedType === "leafref" && !requireInstanceDisabled(schemaNode)) {
      const targets = resolveLeafref(schemaNode, element);
      if (targets === undefined) {
        // A path that cannot even be compiled (constraint referencing an
        // unresolvable QName of its declaring module) leaves the constraint
        // undecidable: indeterminate, not dangling.
        if (leafrefPathStatementOf(schemaNode)) indeterminate = true;
      } else if (targets.length === 0) {
        issue("leafref-dangling", schemaNode, `leafref '${schemaNode.path}' does not resolve in the instance`);
      }
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
      const parsed = parseInstanceIdentifier(value, element);
      if (!parsed.ok) {
        issue("instance-identifier-invalid", schemaNode, `instance-identifier '${schemaNode.path}' is not a valid instance-identifier: ${parsed.reason}`);
      } else {
        const schemaError = validateInstanceIdentifierSchema(schema, parsed.steps, requireInstance ? schemaNode : undefined);
        if (schemaError) {
          issue("instance-identifier-invalid", schemaNode, `instance-identifier '${schemaNode.path}' is not valid for the schema: ${schemaError}`);
        } else if (requireInstance && !resolvesInstanceIdentifier(store, parsed.steps, schema)) {
          issue("instance-identifier-dangling", schemaNode, `instance-identifier of '${schemaNode.path}' does not resolve in the instance`);
        }
      }
    }
    for (const child of schemaNode.children) {
      if (child.kind === "choice" || child.kind === "case") { checkInstanceIdentifiers(element, child, store); continue; }
      for (const entry of elementsOf(element, child)) checkInstanceIdentifiers(entry, child, store);
    }
  }

  // Validate one shared accessible datastore (RFC 7950 §6.4.1): defaults are
  // injected, config-false state data is filtered when requested, and absolute
  // instance-identifiers can resolve siblings under a transport wrapper.
  const rawTop = instance.documentElement;
  if (!rawTop) return { status: indeterminate ? "indeterminate" : "valid", issues };
  if (cancelledNow()) cancelled = true;
  const roots = schema.roots.filter(root => root.kind !== "choice" && root.kind !== "case" && (includeState || root.config));
  const hasDataRoot = roots.some(root => rawTop.localName === root.name && rawTop.namespaceURI === root.namespace || elementsOf(rawTop, root).length > 0);
  if (!cancelled && hasDataRoot) {
    const accessible = buildAccessibleTree(schema, instance, { context: includeState ? "datastore-state" : "datastore-config" });
    const accessibleTop = accessible.document.documentElement!;
    for (const root of roots) {
      if (cancelled) break;
      const present = accessibleTop.localName === root.name && accessibleTop.namespaceURI === root.namespace
        ? [accessibleTop]
        : elementsOf(accessibleTop, root);
      for (const entry of present) {
        if (cancelled) break;
        checkLeafrefs(entry, root);
        checkInstanceIdentifiers(entry, root, accessible.document);
        visitElement(entry, root);
      }
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
interface QualifiedInstanceName { localName: string; namespace: string }
type IdentifierPredicate =
  | { kind: "key"; key: QualifiedInstanceName | "."; value: string }
  | { kind: "position"; position: number };
interface IdentifierStep {
  name: QualifiedInstanceName;
  predicates: IdentifierPredicate[];
}

type ParsedIdentifier =
  | { ok: true; steps: IdentifierStep[] }
  | { ok: false; reason: string };

type ParsedStep =
  | { ok: true; step: IdentifierStep }
  | { ok: false; reason: string };

/**
 * Parse the instance-identifier lexical form: a root-anchored path of node
 * names with `[key = value]` or `[. = value]` predicates. Every QName must
 * have a prefix declared on the instance-identifier element (RFC 7950 §9.13.2).
 * Values may be quoted; unquoted values stop at path/predicate delimiters.
 */
function parseInstanceIdentifier(value: string, context: Element): ParsedIdentifier {
  if (!value.startsWith("/")) return { ok: false, reason: "must start with '/'" };
  const segments = splitTopLevel(value);
  if (!segments) return { ok: false, reason: "unbalanced brackets or quotes" };
  const steps: IdentifierStep[] = [];
  for (const segment of segments.slice(1)) {
    const parsed = parseStep(segment, context);
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

function parseStep(segment: string, context: Element): ParsedStep {
  const bracketStart = segment.indexOf("[");
  const name = bracketStart >= 0 ? segment.slice(0, bracketStart) : segment;
  const qualifiedName = resolveInstanceQName(name, context);
  if (!qualifiedName) return { ok: false, reason: `invalid or unbound qualified node name '${name}'` };
  const predicates: IdentifierPredicate[] = [];
  let rest = segment.slice(name.length);
  while (rest.length) {
    if (!rest.startsWith("[")) return { ok: false, reason: `malformed predicate in '${segment}'` };
    const end = closingBracket(rest);
    if (end < 0) return { ok: false, reason: "unbalanced brackets" };
    const predicate = parsePredicate(rest.slice(1, end));
    if (!predicate.ok) return predicate;
    if (predicate.kind === "position") predicates.push(predicate);
    else if (predicate.key === ".") predicates.push({ kind: "key", key: ".", value: predicate.value });
    else {
      const key = resolveInstanceQName(predicate.key, context);
      if (!key) return { ok: false, reason: `invalid or unbound predicate name '${predicate.key}'` };
      predicates.push({ kind: "key", key, value: predicate.value });
    }
    rest = rest.slice(end + 1);
  }
  const positions = predicates.filter(predicate => predicate.kind === "position");
  const leafListValues = predicates.filter(predicate => predicate.kind === "key" && predicate.key === ".");
  if ((positions.length && predicates.length !== 1) || (leafListValues.length && predicates.length !== 1)) {
    return { ok: false, reason: `incompatible predicates in '${segment}'` };
  }
  const keys = predicates.filter((predicate): predicate is Extract<IdentifierPredicate, { kind: "key" }> =>
    predicate.kind === "key" && predicate.key !== ".");
  const keyNames = keys.map(predicate => {
    const key = predicate.key as QualifiedInstanceName;
    return `${key.namespace}\0${key.localName}`;
  });
  if (new Set(keyNames).size !== keyNames.length) return { ok: false, reason: `duplicate key predicate in '${segment}'` };
  return { ok: true, step: { name: qualifiedName, predicates } };
}

function resolveInstanceQName(value: string, context: Element): QualifiedInstanceName | undefined {
  const match = value.match(/^([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)$/);
  if (!match) return undefined;
  const namespace = context.lookupNamespaceURI(match[1]!);
  return namespace ? { localName: match[2]!, namespace } : undefined;
}

/** Validate each step and its predicate form against the compiled schema (§9.13). */
function validateInstanceIdentifierSchema(
  schema: CompiledYangSchema,
  steps: IdentifierStep[],
  referenceNode?: CompiledSchemaNode,
): string | undefined {
  let candidates = schemaDataNodes(schema.roots);
  for (const [index, step] of steps.entries()) {
    const matches = candidates.filter(candidate =>
      candidate.name === step.name.localName && candidate.namespace === step.name.namespace);
    if (matches.length !== 1) return `node '${step.name.localName}' is not a unique schema node`;
    const node = matches[0]!;
    const predicates = step.predicates;
    if (node.kind === "list") {
      const keys = schemaListKeys(schema, node);
      if (keys === undefined) return `list '${node.name}' has an unresolvable key definition`;
      if (keys.length === 0) {
        if (predicates.length !== 1 || predicates[0]?.kind !== "position") {
          return `list '${node.name}' without keys requires one positional predicate`;
        }
      } else {
        const actual = predicates.filter((predicate): predicate is Extract<IdentifierPredicate, { kind: "key" }> =>
          predicate.kind === "key" && predicate.key !== ".");
        if (actual.length !== predicates.length || actual.length !== keys.length ||
            keys.some(key => !actual.some(predicate => sameQualifiedName(predicate.key as QualifiedInstanceName, key)))) {
          return `list '${node.name}' requires one equality predicate for every key`;
        }
      }
    } else if (node.kind === "leaf-list") {
      if (predicates.length !== 1 || predicates[0]?.kind !== "key" || predicates[0].key !== ".") {
        return `leaf-list '${node.name}' requires one value predicate`;
      }
    } else if (predicates.length) {
      return `node '${node.name}' does not allow predicates`;
    }
    if (index === steps.length - 1 && referenceNode?.config && !node.config) {
      return "a configuration instance-identifier cannot reference state data";
    }
    candidates = schemaDataNodes(node.children);
  }
  return undefined;
}

function schemaDataNodes(nodes: readonly CompiledSchemaNode[]): CompiledSchemaNode[] {
  return nodes.flatMap(node => node.kind === "choice" || node.kind === "case"
    ? schemaDataNodes(node.children)
    : [node]);
}

function schemaListKeys(schema: CompiledYangSchema, list: CompiledSchemaNode): QualifiedInstanceName[] | undefined {
  const prefixes = documentNamespacePrefixes(schema, list.declaredIn);
  const resolved = list.keys.map(key => {
    const colon = key.indexOf(":");
    if (colon < 0) return { localName: key, namespace: list.namespace };
    const namespace = prefixes[key.slice(0, colon)];
    return namespace ? { localName: key.slice(colon + 1), namespace } : undefined;
  });
  if (resolved.some(key => key === undefined)) return undefined;
  const keys = resolved as QualifiedInstanceName[];
  const children = schemaDataNodes(list.children);
  return keys.every(key => children.some(child => child.kind === "leaf" &&
    child.name === key.localName && child.namespace === key.namespace)) ? keys : undefined;
}

function sameQualifiedName(left: QualifiedInstanceName, right: QualifiedInstanceName): boolean {
  return left.localName === right.localName && left.namespace === right.namespace;
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
  | { ok: true; kind: "key"; key: string | "."; value: string }
  | { ok: true; kind: "position"; position: number }
  | { ok: false; reason: string };

function parsePredicate(text: string): ParsedPredicate {
  const positional = text.match(/^\s*([1-9][0-9]*)\s*$/);
  if (positional) {
    const position = Number(positional[1]);
    return Number.isSafeInteger(position)
      ? { ok: true, kind: "position", position }
      : { ok: false, reason: `positional predicate is outside the safe integer range '[${text}]'` };
  }
  const match = text.match(
    /^\s*([A-Za-z_][\w.-]*:[A-Za-z_][\w.-]*|\.)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*$/,
  );
  if (!match) return { ok: false, reason: `malformed predicate '[${text}]'` };
  const raw = match[2] ?? "";
  const quoted = raw.length > 1 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")));
  const value = quoted ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw.trim();
  return { ok: true, kind: "key", key: match[1]!, value };
}

/** Resolve parsed steps against the instance document by expanded QName. */
function resolvesInstanceIdentifier(instance: Document, steps: IdentifierStep[], schema: CompiledYangSchema): boolean {
  let current: Element | undefined;
  const documentRoot = instance.documentElement;
  const isDataRoot = documentRoot && schemaDataNodes(schema.roots).some(root =>
    root.name === documentRoot.localName && root.namespace === documentRoot.namespaceURI);
  let siblings: Element[] = documentRoot
    ? isDataRoot
      ? [documentRoot]
      : Array.from(documentRoot.childNodes).filter((node): node is Element => node.nodeType === 1)
    : [];
  for (const step of steps) {
    const matches = siblings.filter(element => matchesQualifiedName(element, step.name));
    const positional = step.predicates.find(predicate => predicate.kind === "position");
    const selected = positional
      ? (step.predicates.length === 1 ? matches[positional.position - 1] : undefined)
      : matches.filter(element => matchPredicates(element, step.predicates));
    if (!selected || (Array.isArray(selected) ? selected.length !== 1 : false)) return false;
    current = Array.isArray(selected) ? selected[0] : selected;
    if (!current) return false;
    siblings = Array.from(current.childNodes).filter((node): node is Element => node.nodeType === 1);
  }
  return current !== undefined;
}

function matchesQualifiedName(element: Element, name: QualifiedInstanceName): boolean {
  return element.localName === name.localName && (element.namespaceURI ?? "") === name.namespace;
}

function matchPredicates(element: Element, predicates: IdentifierPredicate[]): boolean {
  // Check each supplied equality here. Whether a list needs every key
  // predicate is a schema-aware check and remains outside this helper.
  for (const predicate of predicates) {
    if (predicate.kind === "position") return false;
    if (predicate.key === ".") {
      if ((element.textContent ?? "") !== predicate.value) return false;
      continue;
    }
    const predicateKey = predicate.key;
    const key = Array.from(element.childNodes).find(child => child.nodeType === 1 &&
      matchesQualifiedName(child as Element, predicateKey)) as Element | undefined;
    if (!key || (key.textContent ?? "") !== predicate.value) return false;
  }
  return true;
}
