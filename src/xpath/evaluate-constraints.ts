import { YangStatement } from "../yang/ast.js";
import { childOf, childrenOf } from "../yang/parser.js";
import { CompiledSchemaNode, CompiledYangSchema } from "../yang/compiler.js";
import { schemaNodeForElement } from "./accessible-tree.js";
import { compileYangXPath } from "./xpath.js";
import { XPathFunction } from "xpath";
import { createYangFunctionLibrary } from "./yang-functions.js";

export type ConstraintStatus = "met" | "unmet" | "indeterminate";
export interface ConstraintEvaluation {
  kind: "must" | "when";
  expression: string;
  status: ConstraintStatus;
  source: YangStatement;
}

/**
 * RFC 7950 section 7.5.3: `must` context node is the data node itself;
 * section 7.21.5: `when` context node is the conditional data node itself
 * (augment whens were already attached at their target by the compiler).
 */
export interface ConstraintEvaluator {  /** Evaluate every must/when recorded on the element's compiled schema node. */
  evaluateNode(element: Element): ConstraintEvaluation[];
}

/**
 * Evaluate compiled `must`/`when` constraints against instance data (typically
 * a tree built with `buildAccessibleTree`). Expressions compile per declaring
 * module prefix map and evaluate with the RFC 7950 function library; failures
 * surface as `indeterminate`, never as silently satisfied constraints.
 */
export function createConstraintEvaluator(schema: CompiledYangSchema): ConstraintEvaluator {
  const libraryCache = new Map<string, Record<string, XPathFunction>>();
  const moduleByName = (name: string) => schema.modules.find(module => module.argument === name);

  const libraryFor = (moduleName: string) => {
    const cached = libraryCache.get(moduleName);
    if (cached) return cached;
    const prefixModules: Record<string, string> = {};
    const owner = moduleByName(moduleName);
    if (owner) for (const importNode of childrenOf(owner, "import")) {
      const prefix = childOf(importNode, "prefix")?.argument;
      if (prefix && importNode.argument) prefixModules[prefix] = importNode.argument;
    }
    const created = createYangFunctionLibrary({
      schema, module: moduleName,
      ...(Object.keys(prefixModules).length ? { prefixModules } : {}),
    });
    libraryCache.set(moduleName, created);
    return created;
  };
  const compiledFor = (expressionModule: string, expression: string) =>
    compileModuleExpression(schema, expressionModule, expression);
  const finish = (kind: "must" | "when", statement: YangStatement, status: ConstraintStatus): ConstraintEvaluation => ({
    kind, expression: statement.argument ?? "", status, source: statement,
  });

  return {
    evaluateNode(element: Element): ConstraintEvaluation[] {
      const schemaNode = schemaNodeForElement(schema, element);
      if (!schemaNode) return [];
      const moduleName = schemaNode.module;
      const evaluate = (kind: "must" | "when", statement: YangStatement): ConstraintEvaluation => {
        const context = kind === "when" && !ownWhens.has(statement) && element.parentElement ? element.parentElement : element;
        const compiled = compiledFor(moduleName, statement.argument ?? "");
        if (!compiled) return finish(kind, statement, "indeterminate");
        try {
          return finish(kind, statement, compiled.evaluateBoolean({
            node: context,
            // The evaluator keys custom functions by local name only, so the
            // per-module library also answers `yang:`-prefixed calls.
            functions: libraryFor(moduleName),
          }) ? "met" : "unmet");
        } catch {
          return finish(kind, statement, "indeterminate");
        }
      };
      // Whens inherited from an augment/uses/ancestor statement were
      // introduced by the parent schema node, so the parent element is their
      // context (e.g. an augment when evaluates at its target).
      const ownWhens = new Set(childrenOf(schemaNode.source, "when"));
      return [
        ...schemaNode.must.map(statement => evaluate("must", statement)),
        ...schemaNode.whenConstraints.map(statement => evaluate("when", statement)),
      ];
    },
  };
}

const moduleExpressionCache = new Map<string, ReturnType<typeof compileYangXPath> | undefined>();

/**
 * Compile an RFC 7950 XPath for reuse across constraint and validation passes:
 * the expression's prefixes resolve through the declaring module's imports and
 * unprefixed node tests resolve in the module namespace.
 */
export function compileModuleExpression(schema: CompiledYangSchema, moduleName: string, expression: string) {
  const key = `${moduleName}:${expression}`;
  const cached = moduleExpressionCache.get(key);
  if (cached !== undefined) return cached;
  if (moduleExpressionCache.has(key)) return undefined;
  let created: ReturnType<typeof compileYangXPath> | undefined;
  try {
    const owner = schema.modules.find(module => module.argument === moduleName);
    const prefixModules: Record<string, string> = {};
    if (owner) for (const importNode of childrenOf(owner, "import")) {
      const prefix = childOf(importNode, "prefix")?.argument;
      const imported = schema.modules.find(module => module.argument === importNode.argument);
      const namespace = imported && childOf(imported, "namespace")?.argument;
      if (prefix && namespace) prefixModules[prefix] = namespace;
    }
    const namespace = owner ? childOf(owner, "namespace")?.argument ?? "" : "";
    created = compileYangXPath(expression, namespace, prefixModules);
  } catch {
    created = undefined;
  }
  moduleExpressionCache.set(key, created);
  return created;
}
