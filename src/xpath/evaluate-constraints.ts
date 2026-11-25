import { YangStatement } from "../yang/ast.js";
import { childOf, childrenOf } from "../yang/parser.js";
import { CompiledSchemaNode, CompiledYangSchema } from "../yang/compiler.js";
import { schemaNodeForElement } from "./accessible-tree.js";
import { compileYangXPath, CompiledYangXPath } from "./xpath.js";
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
export interface ConstraintEvaluator {
  /** Evaluate every must/when recorded on the element's compiled schema node. */
  evaluateNode(element: Element): ConstraintEvaluation[];
}

/**
 * Evaluate compiled `must`/`when` constraints against instance data (typically
 * a tree built with `buildAccessibleTree`). Expressions compile per declaring
 * module prefix map and evaluate with the RFC 7950 function library; failures
 * surface as `indeterminate`, never as silently satisfied constraints.
 */
export function createConstraintEvaluator(schema: CompiledYangSchema): ConstraintEvaluator {
  const compiledCache = new Map<string, CompiledYangXPath>();
  const libraryCache = new Map<string, Record<string, XPathFunction>>();
  const moduleByName = (name: string) => schema.modules.find(module => module.argument === name);

  const importedNamespaces = (moduleName: string): Record<string, string> => {
    const owner = moduleByName(moduleName);
    const namespaces: Record<string, string> = {};
    if (!owner) return namespaces;
    for (const importNode of childrenOf(owner, "import")) {
      const prefix = childOf(importNode, "prefix")?.argument;
      const namespace = moduleByName(importNode.argument ?? "") && childOf(moduleByName(importNode.argument ?? "")!, "namespace")?.argument;
      if (prefix && namespace) namespaces[prefix] = namespace;
    }
    return namespaces;
  };
  const moduleNamespace = (moduleName: string): string => {
    const owner = moduleByName(moduleName);
    return owner ? childOf(owner, "namespace")?.argument ?? "" : "";
  };
  const prefixModuleNames = (moduleName: string): Record<string, string> => {
    const owner = moduleByName(moduleName);
    const map: Record<string, string> = {};
    if (!owner) return map;
    for (const importNode of childrenOf(owner, "import")) {
      const prefix = childOf(importNode, "prefix")?.argument;
      if (prefix && importNode.argument) map[prefix] = importNode.argument;
    }
    return map;
  };
  const libraryFor = (moduleName: string) => {
    const cached = libraryCache.get(moduleName);
    if (cached) return cached;
    const created = createYangFunctionLibrary({
      schema, module: moduleName,
      ...(Object.keys(prefixModuleNames(moduleName)).length ? { prefixModules: prefixModuleNames(moduleName) } : {}),
    });
    libraryCache.set(moduleName, created);
    return created;
  };
  const compiledFor = (expressionModule: string, expression: string): CompiledYangXPath | undefined => {
    const key = `${expressionModule}:${expression}`;
    const cached = compiledCache.get(key);
    if (cached) return cached;
    let created: CompiledYangXPath | undefined;
    try {
      created = compileYangXPath(expression, moduleNamespace(expressionModule), importedNamespaces(expressionModule));
    } catch {
      created = undefined;
    }
    if (created) compiledCache.set(key, created);
    return created;
  };
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
