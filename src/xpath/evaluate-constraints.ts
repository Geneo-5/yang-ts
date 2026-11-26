import { YangStatement } from "../yang/ast.js";
import { childOf, childrenOf } from "../yang/parser.js";
import { CompiledSchemaNode, CompiledYangSchema, documentNamespacePrefixes } from "../yang/compiler.js";
import { documentNamespace as documentNamespaceOfSchema, documentOf as documentOfSchema } from "../yang/compiler.js";
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
    // Identity prefixes: RFC 7950 §14 resolves `derived-from` bases through the
    // declaring module's imports and its own prefix.
    const owner = moduleByName(moduleName);
    const prefixModules: Record<string, string> = {};
    if (owner) {
      const ownPrefix = childOf(owner, "prefix")?.argument;
      if (ownPrefix) prefixModules[ownPrefix] = moduleName;
      for (const importNode of childrenOf(owner, "import")) {
        const prefix = childOf(importNode, "prefix")?.argument;
        if (prefix && importNode.argument) prefixModules[prefix] = importNode.argument;
      }
    }
    const created = createYangFunctionLibrary({
      schema, module: moduleName,
      ...(Object.keys(prefixModules).length ? { prefixModules } : {}),
    });
    libraryCache.set(moduleName, created);
    return created;
  };
  // A constraint's prefixes live in the document that declared it: the module,
  // or the submodule carrying the statement (RFC 7950 §6.4.1).
  const compiledFor = (expressionModule: string, expression: string, documentName?: string) =>
    compileModuleExpression(schema, expressionModule, expression, documentName ?? expressionModule);
  const finish = (kind: "must" | "when", statement: YangStatement, status: ConstraintStatus): ConstraintEvaluation => ({
    kind, expression: statement.argument ?? "", status, source: statement,
  });

  return {
    evaluateNode(element: Element): ConstraintEvaluation[] {
      const schemaNode = schemaNodeForElement(schema, element);
      if (!schemaNode) return [];
      const moduleName = schemaNode.module;
      // RFC 7950 section 7.21.5: a `when`'s context node is the element of the
      // schema node it applies to — the node itself for its own `when`; for
      // ones inherited from a uses, an augment or an ancestor data node, the
      // element resolving to the recorded holder path. An ancestor-declared
      // `when` evaluated at the immediate parent rewrites `../` expressions
      // against the wrong level of the tree.
      const contextForWhen = (holder: string): Node | undefined => {
        let current: Node | null = element;
        while (current && current.nodeType === 1) {
          const candidate = schemaNodeForElement(schema, current as Element);
          if (candidate?.path === holder) return current;
          current = current.parentNode;
        }
        return undefined;
      };
      const evaluate = (kind: "must" | "when", statement: YangStatement, holder?: string): ConstraintEvaluation => {
        if (kind === "when") {
          const context = holder ? contextForWhen(holder) : element;
          if (!context) return finish(kind, statement, "indeterminate");
          const compiled = compiledFor(moduleName, statement.argument ?? "", schemaNode.declaredIn);
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
        }
        const compiled = compiledFor(moduleName, statement.argument ?? "", schemaNode.declaredIn);
        if (!compiled) return finish(kind, statement, "indeterminate");
        try {
          return finish(kind, statement, compiled.evaluateBoolean({
            node: element,
            functions: libraryFor(moduleName),
          }) ? "met" : "unmet");
        } catch {
          return finish(kind, statement, "indeterminate");
        }
      };
      return [
        ...schemaNode.must.map(statement => evaluate("must", statement)),
        ...schemaNode.whenConstraints.map((statement, index) =>
          evaluate("when", statement, schemaNode.whenHolders[index])),
      ];
    },
  };
}

// Compiled expressions are scoped to their schema: a module-level map keyed
// by "module:expression" would answer one schema's compiled path for another
// schema that reuses the module name, and would outlive every schema.
const moduleExpressionCache = new WeakMap<CompiledYangSchema, Map<string, ReturnType<typeof compileYangXPath> | undefined>>();

/**
 * Compile an RFC 7950 XPath for reuse across constraint and validation passes:
 * the expression's prefixes resolve through the namespace declarations in
 * scope for `documentName` (RFC 7950 §6.4.1 — the module's own, or the named
 * submodule's plus its parent's), and unprefixed node tests resolve in the
 * document's namespace. `documentName` defaults to `moduleName` for callers
 * that know the expression is written in the module document; constraint
 * compilation passes the declaring submodule name so its prefixes resolve.
 */
export function compileModuleExpression(schema: CompiledYangSchema, moduleName: string, expression: string, documentName?: string) {
  const docName = documentName ?? moduleName;
  let scoped = moduleExpressionCache.get(schema);
  if (!scoped) { scoped = new Map(); moduleExpressionCache.set(schema, scoped); }
  const key = `${docName}:${expression}`;
  if (scoped.has(key)) return scoped.get(key);
  let created: ReturnType<typeof compileYangXPath> | undefined;
  try {
    if (!documentOfSchema(schema, docName)) throw new Error(`document ${docName} is not part of the schema`);
    created = compileYangXPath(expression, documentNamespaceOfSchema(schema, docName) ?? "", documentNamespacePrefixes(schema, docName));
  } catch {
    created = undefined;
  }
  scoped.set(key, created);
  return created;
}
