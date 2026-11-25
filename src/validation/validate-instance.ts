import { CompiledSchemaNode, CompiledYangSchema } from "../yang/compiler.js";
import { createConstraintEvaluator } from "../xpath/evaluate-constraints.js";
import { createLeafrefResolver } from "../xpath/yang-functions.js";

export type ValidationIssueCode =
  | "too-few-elements"
  | "too-many-elements"
  | "missing-key"
  | "duplicate-key"
  | "missing-mandatory"
  | "missing-choice"
  | "unique-violation"
  | "leafref-dangling"
  | "must-unmet"
  | "when-unexpected-node";

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
        const present = choiceEntries(element, child);
        if (!present.length && child.properties.mandatory?.[0]?.argument === "true") {
          if (child.whenConstraints.length) { indeterminate = true; continue; }
          issue("missing-choice", child, `choice '${child.name}' requires one case`);
        }
        continue;
      }
      if (child.kind === "case") continue;
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
            if (statuses.every(status => status === "unmet")) continue;
            if (statuses.some(status => status === "indeterminate")) { indeterminate = true; continue; }
          } finally { element.removeChild(probe); }
        }
        checkAbsentRequirements(child);
        continue;
      }
      if (child.kind === "list") checkList(child, entries);
      for (const entry of entries) visitElement(entry, child);
    }
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
    const uniquePaths = (child.properties.unique?.[0]?.argument ?? "").split(/\s+/).filter(Boolean);
    const seenKeys = new Set<string>();
    const seenUnique = new Set<string>();
    for (const entry of entries) {
      const descendantValue = (name: string): string => {
        const found = Array.from(entry.getElementsByTagName("*")).find(candidate => candidate.localName === name && candidate.namespaceURI === child.namespace);
        return found ? found.textContent ?? "" : "";
      };
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
      if (uniquePaths.length) {
        const signature = uniquePaths.map(descendantValue).join("\u0000");
        if (seenUnique.has(signature)) issue("unique-violation", child, `unique '${child.properties.unique![0]!.argument}' is violated in list '${child.name}'`);
        seenUnique.add(signature);
      }
    }
  }

  function checkLeafrefs(element: Element, schemaNode: CompiledSchemaNode): void {
    if (schemaNode.resolvedType === "leafref" && schemaNode.properties["require-instance"]?.[0]?.argument !== "false"
      && resolveLeafref(schemaNode, element)?.length === 0) {
      issue("leafref-dangling", schemaNode, `leafref '${schemaNode.path}' does not resolve in the instance`);
    }
    for (const child of schemaNode.children) {
      if (child.kind === "choice" || child.kind === "case") { checkLeafrefs(element, child); continue; }
      for (const entry of elementsOf(element, child)) checkLeafrefs(entry, child);
    }
  }

  const top = instance.documentElement;
  if (!top) return { status: indeterminate ? "indeterminate" : "valid", issues };
  for (const root of schema.roots) {
    if (root.kind === "choice" || root.kind === "case") continue;
    if (!includeState && !root.config) continue;
    const present = top.localName === root.name && top.namespaceURI === root.namespace ? [top] : elementsOf(top, root);
    for (const entry of present) {
      checkLeafrefs(entry, root);
      visitElement(entry, root);
    }
  }
  return { status: issues.length ? "invalid" : indeterminate ? "indeterminate" : "valid", issues };
}
