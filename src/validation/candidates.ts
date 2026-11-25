import { YangStatement } from "../yang/ast.js";
import { childOf, childrenOf } from "../yang/parser.js";
import { CompiledSchemaNode, CompiledYangSchema } from "../yang/compiler.js";
import { createConstraintEvaluator } from "../xpath/evaluate-constraints.js";
import { findSchemaNodeByPath } from "../xpath/accessible-tree.js";

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
}

export interface FiniteDomain {
  domain: CandidateDomain;
  values: string[];
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
  if (bits.length) return { domain: "bits", values: bits };
  if (layers[layers.length - 1]!.argument === "boolean") return { domain: "boolean", values: ["true", "false"] };
  return { domain: "none", values: [] };
}

/**
 * Locate the instance element, walking from the root through path segments
 * that are present. When the element itself is absent (typically a leaf gated
 * by a `when`), returns the parent that would hold it so candidates can be
 * probed with a placeholder.
 */
function locateElement(instance: Document, node: CompiledSchemaNode): { element?: Element; parent?: Element } {
  const parts = node.path.split("/").filter(Boolean);
  const top = instance.documentElement;
  if (!top) return {};
  let current: Element | undefined = top;
  // The document element may itself be the first path segment.
  for (let index = top.localName === parts[0] ? 1 : 0; current && index < parts.length; index++) {
    const next = Array.from(current.childNodes).find(child => child.nodeType === 1 &&
      (child as Element).localName === parts[index] && (child as Element).namespaceURI === node.namespace);
    if (!next) {
      // A missing middle segment means the target context does not exist.
      return index === parts.length - 1 ? { parent: current } : {};
    }
    current = next as Element;
  }
  return current ? { element: current } : {};
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
 * Absent (typically when-gated) leaves are probed with a temporary
 * placeholder; every candidate carries per-constraint reasons with the
 * declaring statement as source.
 */
export function evaluateCandidates(
  schema: CompiledYangSchema,
  instance: Document,
  path: string,
  options: CandidateOptions = {},
): CandidateResult {
  const node = findSchemaNodeByPath(schema, path);
  if (!node) return { path, domain: "none", candidates: [] };
  const domain = finiteDomainOf(node);
  if (domain.domain === "none") return { path, domain: domain.domain, candidates: [] };

  const evaluator = createConstraintEvaluator(schema);
  const { element, parent } = locateElement(instance, node);
  if (!element && !parent) {
    // No context in the document at all: candidates cannot be classified.
    return {
      path, domain: domain.domain,
      candidates: domain.values.map(value => ({
        value, status: "indeterminate" as const, reasons: [] as CandidateReason[],
      })),
    };
  }

  let placeholder: Element | undefined;
  let context: Element | undefined = element;
  if (!context && parent) {
    placeholder = instance.createElementNS(node.namespace, node.name);
    parent.appendChild(placeholder);
    context = placeholder;
  }
  const originalText = element ? element.textContent : null;
  const bitsSelection = options.bitsSelection ?? [];

  const candidates = domain.values.map(value => {
    const tested = domain.domain === "bits"
      ? Array.from(new Set([...bitsSelection, value])).sort().join(" ")
      : value;
    context!.textContent = tested;
    let status: CandidateStatus = "allowed";
    const reasons: CandidateReason[] = [];
    for (const evaluation of evaluator.evaluateNode(context!)) {
      if (evaluation.status === "met") continue;
      const { status: classification, reason } = classify(evaluation);
      // An unevaluable constraint is a stronger signal than a false one: the
      // candidate must not be filtered out statically, only flagged.
      status = classification === "indeterminate" ? "indeterminate"
        : status === "indeterminate" ? "indeterminate" : "blocked";
      reasons.push(reason);
    }
    return { value, status, reasons };
  });

  if (placeholder) {
    placeholder.parentElement?.removeChild(placeholder);
  } else if (originalText !== null) context!.textContent = originalText;
  return { path, domain: domain.domain, candidates };
}
