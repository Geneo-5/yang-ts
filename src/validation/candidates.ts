import { YangStatement } from "../yang/ast.js";
import { childOf, childrenOf } from "../yang/parser.js";
import { CompiledSchemaNode, CompiledYangSchema } from "../yang/compiler.js";
import { createConstraintEvaluator, ConstraintEvaluation, compileModuleExpression } from "../xpath/evaluate-constraints.js";
import { buildAccessibleTree, schemaNodeChainByPath, flattenDataChildren } from "../xpath/accessible-tree.js";

export type CandidateStatus = "allowed" | "blocked" | "indeterminate";
export type CandidateDomain = "enum" | "bits" | "boolean" | "none";

export interface CandidateReason {
  code: "must-unmet" | "when-unmet" | "constraint-indeterminate";
  message: string;
  /** The must/when statement that produced this reason. */
  source: YangStatement;
}

export interface CandidateEvaluation {
  value: string;
  status: CandidateStatus;
  reasons: CandidateReason[];
}

export interface CandidateResult {
  /** Bare schema path of the evaluated node. */
  path: string;
  domain: CandidateDomain;
  candidates: CandidateEvaluation[];
}

export interface CandidateOptions {
  /**
   * Base selection for `bits` domains: each candidate bit is toggled into this
   * selection before the constraints are evaluated against the resulting value.
   */
  bitsSelection?: readonly string[];
  /**
   * Cooperative cancellation: an aborted signal leaves every candidate
   * `indeterminate` with a `constraint-indeterminate` reason instead of
   * evaluating constraints on a stopped consumer's behalf.
   */
  signal?: AbortSignal;
}

export interface FiniteDomain {
  domain: CandidateDomain;
  values: string[];
  /** RFC 7950 §9.7.4 bit positions (explicit or implied) for `bits` domains. */
  positions?: ReadonlyMap<string, number>;
}

/**
 * Candidate values of a finite domain (enumeration, bits, boolean): the base
 * type's declarations filtered by restrictions along the typedef chain.
 * Restriction legality is checked by the compiler, so a restriction here only
 * ever narrows the base set.
 */
export function finiteDomainOf(node: CompiledSchemaNode): FiniteDomain {
  const layers: YangStatement[] = [
    ...(node.type ? [node.type] : []),
    ...node.typedefChain.map(typedef => childOf(typedef, "type")).filter((t): t is YangStatement => t !== undefined),
  ];
  if (!layers.length) return { domain: "none", values: [] };
  const values = (baseTypeName: string, keyword: "enum" | "bit"): string[] => {
    let baseIndex = -1;
    for (let index = layers.length - 1; index >= 0; index--) {
      if (layers[index]?.argument === baseTypeName) { baseIndex = index; break; }
    }
    if (baseIndex < 0) return [];
    let values = childrenOf(layers[baseIndex]!, keyword).map(option => option.argument ?? "");
    for (let index = baseIndex - 1; index >= 0; index--) {
      const restricted = childrenOf(layers[index]!, keyword).map(option => option.argument ?? "");
      if (restricted.length) {
        const allowed = new Set(restricted);
        values = values.filter(value => allowed.has(value));
      }
    }
    return values;
  };
  const enums = values("enumeration", "enum");
  if (enums.length) return { domain: "enum", values: enums };
  const bits = values("bits", "bit");
  if (bits.length) {
    // RFC 7950 §9.7.4: a bit without an explicit `position` is one greater
    // than its predecessor (0 for the first); canonical form joins selections
    // ordered by position.
    let baseIndex = -1;
    for (let index = layers.length - 1; index >= 0; index--) {
      if (layers[index]!.argument === "bits") { baseIndex = index; break; }
    }
    const positions = new Map<string, number>();
    let next = 0;
    for (const bit of childrenOf(layers[baseIndex]!, "bit")) {
      const declared = childOf(bit, "position")?.argument;
      if (declared !== undefined && /^\d+$/.test(declared)) next = Number(declared);
      positions.set(bit.argument ?? "", next);
      next++;
    }
    return { domain: "bits", values: bits, positions };
  }
  if (layers[layers.length - 1]!.argument === "boolean") return { domain: "boolean", values: ["true", "false"] };
  return { domain: "none", values: [] };
}

/** One parsed path segment: the (predicate-stripped) name plus key predicates for list entries. */
interface PathSegment {
  name: string;
  predicates: ReadonlyArray<{ key: string; value: string }>;
}

/**
 * Split a schema path into segments: key predicates such as `[name='core']`
 * are parsed off the segment name and kept for entry targeting; choice/case
 * segments stay in place so positional alignment with the schema chain is kept.
 */
function parsePathSegments(path: string): PathSegment[] {
  return path.split("/").filter(Boolean).map(part => {
    const predicates: Array<{ key: string; value: string }> = [];
    const name = part.replace(/\[([^\[\]]+)\]/g, (_match, inner: string) => {
      const predicate = /^([\w.:-]+)\s*=\s*(?:'([^']*)'|"([^"]*)")\s*$/.exec(inner.trim());
      if (predicate) predicates.push({ key: predicate[1]!, value: predicate[2] ?? predicate[3] ?? "" });
      return "";
    });
    return { name, predicates };
  });
}

/** Does `entry` satisfy every key predicate of a list segment? Key leaves hang directly under the entry. */
function entryMatches(
  entry: Element,
  listNode: CompiledSchemaNode,
  predicates: ReadonlyArray<{ key: string; value: string }>,
): boolean {
  return predicates.every(({ key, value }) => {
    const namespace = listNode.children.find(child => child.name === key)?.namespace ?? listNode.namespace;
    return Array.from(entry.childNodes).some(child => child.nodeType === 1
      && (child as Element).localName === key
      && (child as Element).namespaceURI === namespace
      && (child as Element).textContent === value);
  });
}

/**
 * Locate the instance element for the schema node chain, walking from the
 * root through path segments that are present, checking each segment against
 * ITS OWN schema namespace (augmented segments carry another module's
 * namespace). Key predicates select a specific list entry; without them the
 * first matching entry is used. When the element itself is absent (typically
 * a leaf gated by a `when`), returns the parent that would hold it so
 * candidates can be probed with a placeholder. `ancestors` mirrors
 * `dataNodes` positionally up to the deepest located segment.
 */
function locateElement(
  instance: Document,
  dataNodes: readonly CompiledSchemaNode[],
  segments: readonly PathSegment[],
): { element?: Element; parent?: Element; ancestors: Element[] } {
  const top = instance.documentElement;
  if (!top || !dataNodes.length) return { ancestors: [] };
  const ancestors: Element[] = [];
  let current: Element;
  let index: number;
  if (top.localName === dataNodes[0]!.name && top.namespaceURI === dataNodes[0]!.namespace) {
    if (!entryMatches(top, dataNodes[0]!, segments[0]?.predicates ?? [])) return { ancestors: [] };
    current = top;
    index = 1;
    ancestors.push(top);
  } else {
    // The document element is a wrapper (e.g. `<data>`): every segment is a descendant.
    current = top;
    index = 0;
  }
  for (; index < dataNodes.length; index++) {
    const schemaNode = dataNodes[index]!;
    const matches = Array.from(current.childNodes).filter((child): child is Element =>
      child.nodeType === 1
      && (child as Element).localName === schemaNode.name
      && (child as Element).namespaceURI === schemaNode.namespace);
    if (!matches.length) {
      // A missing middle segment means the target context does not exist.
      return index === dataNodes.length - 1 ? { parent: current, ancestors } : { ancestors };
    }
    const predicates = segments[index]?.predicates ?? [];
    const chosen = (predicates.length
      ? matches.find(entry => entryMatches(entry, schemaNode, predicates))
      : matches[0]) as Element | undefined;
    if (!chosen) return { ancestors };
    ancestors.push(chosen);
    current = chosen;
  }
  return { element: current, ancestors };
}

function classify(evaluation: { kind: "must" | "when"; expression: string; status: string; source: YangStatement }): {
  status: "blocked" | "indeterminate";
  reason: CandidateReason;
} {
  if (evaluation.status === "indeterminate") {
    return {
      status: "indeterminate",
      reason: {
        code: "constraint-indeterminate",
        message: `${evaluation.kind} '${evaluation.expression}' could not be evaluated for this value`,
        source: evaluation.source,
      },
    };
  }
  return {
    status: "blocked",
    reason: {
      code: evaluation.kind === "must" ? "must-unmet" : "when-unmet",
      message: `${evaluation.kind} '${evaluation.expression}' is not satisfied by this value`,
      source: evaluation.source,
    },
  };
}

/**
 * Evaluate every finite-domain candidate (enum, bits, boolean) of a schema
 * node against a concrete instance document: the candidate value replaces the
 * element's content, the compiled `must`/`when` constraints are re-evaluated,
 * and unmet constraints block the candidate. An unevaluable `must` — one that
 * depends on data outside the document or uses an unsupported function —
 * leaves the candidate indeterminate instead of filtering it statically.
 * Constraints of ancestors and present siblings that reference the node see
 * the candidate value too. Absent (typically when-gated) leaves are probed
 * with a temporary placeholder; every candidate carries per-constraint
 * reasons with the declaring statement as source. All probing happens on a
 * private clone — the caller's document is never touched (and key
 * predicates, choice/case segments and foreign namespaces locate the node).
 */
export function evaluateCandidates(
  schema: CompiledYangSchema,
  instance: Document,
  path: string,
  options: CandidateOptions = {},
): CandidateResult {
  const chain = schemaNodeChainByPath(schema, path);
  const node = chain?.[chain.length - 1];
  if (!node) return { path, domain: "none", candidates: [] };
  const domain = finiteDomainOf(node);
  if (domain.domain === "none") return { path, domain: domain.domain, candidates: [] };

  const dataNodes = chain.filter(node => node.kind !== "choice" && node.kind !== "case");
  const segments = parsePathSegments(path);

  // Evaluate on the accessible tree buildAccessibleTree produces a fresh
  // document from the instance (defaults materialized, caller's document
  // untouched): no candidate value, no placeholder ever reaches the caller's
  // document, not even via an exceptional constraint.
  const working = buildAccessibleTree(schema, instance, { context: "datastore-config" }).document;
  const evaluator = createConstraintEvaluator(schema);
  const located = locateElement(working, dataNodes, segments);
  if (!located.element && !located.parent) {
    // No context in the document at all: candidates cannot be classified.
    return {
      path, domain: domain.domain,
      candidates: domain.values.map(value => ({
        value, status: "indeterminate" as const, reasons: [] as CandidateReason[],
      })),
    };
  }

  let placeholder: Element | undefined;
  let context: Element | undefined = located.element;
  if (!context && located.parent) {
    placeholder = working.createElementNS(node.namespace, node.name);
    located.parent.appendChild(placeholder);
    context = placeholder;
  }
  // Constraints that also depend on the node: every located ancestor (its own
  // element in the chain) plus, at the parent level, present siblings other
  // than the node itself. The node's own constraints are added separately in
  // the candidate loop.
  const dependents: Element[] = [];
  const ownIndex = located.element ? dataNodes.length - 1 : -1;
  located.ancestors.forEach((element, index) => {
    if (index !== ownIndex) dependents.push(element);
  });
  const parentNode = dataNodes[located.element ? dataNodes.length - 2 : located.ancestors.length - 1];
  const parentElement = located.element?.parentElement ?? located.parent;
  if (parentNode && parentElement) {
    for (const sibling of flattenDataChildren(parentNode.children)) {
      if (sibling === node) continue;
      const siblingElement = Array.from(parentElement.childNodes).find(child => child.nodeType === 1
        && (child as Element).localName === sibling.name
        && (child as Element).namespaceURI === sibling.namespace) as Element | undefined;
      if (siblingElement) dependents.push(siblingElement);
    }
  }
  const bitsSelection = options.bitsSelection ?? [];

  const candidates = domain.values.map(value => {
    if (options.signal?.aborted) {
      return {
        value,
        status: "indeterminate" as const,
        reasons: [{
          code: "constraint-indeterminate" as const,
          message: "Candidate evaluation was cancelled",
          source: node.source,
        }],
      };
    }
    // RFC 6991: the canonical bits lexical form joins the selection ordered
    // by bit position (matching canonicalFormOf), not alphabetically.
    const tested = domain.domain === "bits"
      ? Array.from(new Set([...bitsSelection, value]))
        .sort((left, right) => (domain.positions?.get(left) ?? Number.MAX_SAFE_INTEGER)
          - (domain.positions?.get(right) ?? Number.MAX_SAFE_INTEGER))
        .join(" ")
      : value;
    context!.textContent = tested;
    let status: CandidateStatus = "allowed";
    const reasons: CandidateReason[] = [];
    const record = (evaluation: ConstraintEvaluation): void => {
      if (evaluation.status === "met") return;
      const { status: classification, reason } = classify(evaluation);
      // An unevaluable constraint is a stronger signal than a false one: the
      // candidate must not be filtered out statically, only flagged.
      status = classification === "indeterminate" ? "indeterminate"
        : status === "indeterminate" ? "indeterminate" : "blocked";
      reasons.push(reason);
    };
    for (const evaluation of evaluator.evaluateNode(context!)) record(evaluation);
    for (const element of dependents) {
      for (const evaluation of evaluator.evaluateNode(element)) record(evaluation);
    }
    return { value, status, reasons };
  });

  if (placeholder) {
    placeholder.parentElement?.removeChild(placeholder);
  }
  return { path, domain: domain.domain, candidates };
}
