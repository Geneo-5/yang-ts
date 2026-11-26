import { YangModule, YangStatement } from "./ast.js";
import { childOf, childrenOf } from "./parser.js";
import { YangModuleSet } from "./module-set.js";
import { BUILTIN_TYPES, RESTRICTION_BUILTINS } from "../types/builtins.js";

/** Prefix → namespace map for XPath written inside `moduleName`: its own prefix first (RFC 7950 §6.4.1), then imports.
 * Submodules included by `moduleName` contribute their imports too, and their
 * `belongs-to` prefix resolves to the module's namespace; the module's own
 * declarations win over collisions. */
export function moduleNamespacePrefixes(schema: CompiledYangSchema, moduleName: string): Record<string, string> {
  const map: Record<string, string> = {};
  const put = (prefix: string | undefined, namespace: string | undefined) => {
    if (prefix && namespace && map[prefix] === undefined) map[prefix] = namespace;
  };
  const owner = schema.modules.find(module => module.argument === moduleName);
  const included = owner ? schema.submodules.filter(submodule => childOf(submodule, "belongs-to")?.argument === owner.argument) : [];
  for (const doc of owner ? [owner, ...included] : []) {
    const belongsTo = doc === owner ? undefined : childOf(doc, "belongs-to");
    const parent = belongsTo && schema.modules.find(module => module.argument === belongsTo.argument);
    if (doc === owner) {
      put(childOf(doc, "prefix")?.argument, childOf(doc, "namespace")?.argument);
    } else if (parent) {
      put(belongsTo && childOf(belongsTo, "prefix")?.argument, childOf(parent, "namespace")?.argument);
    }
    for (const importNode of childrenOf(doc, "import")) {
      const imported = schema.modules.find(module => module.argument === importNode.argument);
      put(childOf(importNode, "prefix")?.argument, imported && childOf(imported, "namespace")?.argument);
    }
  }
  return map;
}

export type SchemaNodeKind = "container" | "list" | "leaf" | "leaf-list" | "choice" | "case" | "anydata" | "anyxml";
export interface CompiledSchemaNode {
  kind: SchemaNodeKind;
  name: string;
  module: string;
  namespace: string;
  path: string;
  config: boolean;
  keys: string[];
  type?: YangStatement;
  resolvedType?: string;
  typedefChain: readonly YangStatement[];
  /** Module declaring each typedef of typedefChain, in the same order. */
  typedefChainModules: readonly string[];
  must: readonly YangStatement[];
  whenConstraints: readonly YangStatement[];
  /** Schema path of the node each whenConstraints entry applies to (same order). */
  whenHolders: readonly string[];
  ifFeatures: readonly string[];
  featureRequirements: readonly { module: string; expression: string }[];
  properties: Record<string, YangStatement[]>;
  deviations: YangStatement[];
  source: YangStatement;
  children: CompiledSchemaNode[];
}
export interface CompiledOperation {
  kind: "rpc" | "action" | "notification";
  name: string;
  module: string;
  /** Schema path to an RPC/action/notification; actions include their data-node ancestors. */
  path: string;
  schemaPath: readonly { module: string; name: string }[];
  source: YangStatement;
  data: CompiledSchemaNode[];
  input: CompiledSchemaNode[];
  output: CompiledSchemaNode[];
}
export interface CompiledIdentity {
  name: string;
  module: string;
  namespace: string;
  bases: readonly string[];
  source: YangStatement;
}
export interface CompilerDiagnostic {
  code: "duplicate-node" | "unresolved-prefix" | "unresolved-augment" | "unresolved-grouping" |
    "uses-cycle" | "augment-conflict" | "invalid-key" | "unresolved-type" | "typedef-cycle" |
    "unresolved-feature" | "invalid-feature-expression" | "unresolved-deviation" | "invalid-deviation" |
    "unresolved-refine" | "invalid-refine" | "unresolved-identity" | "identity-cycle" |
    "invalid-augment-target" | "invalid-augment-child" | "invalid-statement-cardinality" |
    "invalid-type-restriction" | "budget-exceeded";
  message: string;
  module: string;
  source: YangStatement;
}
export interface CompiledYangSchema {
  roots: CompiledSchemaNode[];
  operations: CompiledOperation[];
  identities: readonly CompiledIdentity[];
  diagnostics: CompilerDiagnostic[];
  modules: readonly YangModule[];
  submodules: readonly YangModule[];
}

export interface YangCompilerOptions {
  /** Feature identifiers use the declaring module name, e.g. `ietf-interfaces:arbitrary-names`. */
  enabledFeatures?: ReadonlySet<string>;
  /** Resource budget for untrusted modules; expansion stops with one `budget-exceeded` diagnostic when tripped. */
  budget?: {
    /** Maximum number of schema nodes the whole module set may expand to (grouping/`uses` fan-out included). */
    maxSchemaNodes?: number;
  };
}

const DATA_KINDS = new Set<SchemaNodeKind>(["container", "list", "leaf", "leaf-list", "choice", "case", "anydata", "anyxml"]);
const revisionOf = (module: YangModule) => childOf(module, "revision")?.argument ?? "";
const moduleId = (module: YangModule) => `${module.argument}@${revisionOf(module)}`;

function importedModule(context: YangModule, prefix: string, modules: readonly YangModule[], submodules: readonly YangModule[] = []): YangModule | undefined {
  if (childOf(context, "prefix")?.argument === prefix) return context;
  const belongsTo = childOf(context, "belongs-to");
  if (belongsTo && childOf(belongsTo, "prefix")?.argument === prefix) {
    return modules.find(module => module.argument === belongsTo.argument);
  }
  const importNode = childrenOf(context, "import").find(item => childOf(item, "prefix")?.argument === prefix);
  const name = importNode?.argument;
  const candidates = modules.filter(candidate => candidate.argument === name);
  const pinnedRevision = importNode && childOf(importNode, "revision-date")?.argument;
  if (pinnedRevision) return candidates.find(candidate => revisionOf(candidate) === pinnedRevision);
  return candidates.sort((a, b) => revisionOf(b).localeCompare(revisionOf(a)))[0];
}

function resolveQName(context: YangModule, qname: string, modules: readonly YangModule[], submodules: readonly YangModule[] = []): { module: YangModule; name: string } | undefined {
  const split = qname.split(":");
  if (split.length === 1) return { module: context, name: split[0]! };
  if (split.length !== 2) return undefined;
  const module = importedModule(context, split[0]!, modules, submodules);
  return module ? { module, name: split[1]! } : undefined;
}

function dataChildren(node: YangStatement): YangStatement[] {
  return node.children.filter(child => DATA_KINDS.has(child.keyword as SchemaNodeKind) || child.keyword === "uses");
}

/** Compile data trees and apply schema-node augments; type and expression statements remain source-linked for later passes. */
export function compileYangModules(moduleSet: YangModuleSet, options: YangCompilerOptions = {}): CompiledYangSchema {
  const diagnostics: CompilerDiagnostic[] = [];
  // RFC 7950 section 5.6.5: differently pinned imports may pull several
  // revisions of one module into the closure, but every reference binds by
  // module name here, so compilation keeps one revision per name — the
  // newest. `resolveModuleSet` reports `duplicate-revision` when this happens.
  const newestPerName = (nodes: readonly YangModule[]): YangModule[] => {
    const byName = new Map<string, YangModule>();
    for (const node of nodes) {
      const revision = childOf(node, "revision")?.argument ?? "";
      const existing = byName.get(node.argument ?? "");
      byName.set(node.argument ?? "", existing && (childOf(existing, "revision")?.argument ?? "") >= revision ? existing : node);
    }
    return [...byName.values()];
  };
  const modules = newestPerName(moduleSet.modules);
  const submodules = newestPerName(moduleSet.submodules);
  const roots: CompiledSchemaNode[] = [];
  // Resource budget for hostile grouping trees: every node makeNode produces
  // counts; past the ceiling expansion stops dead, so a `uses` fan-out cannot
  // grow the tree unbounded.
  let expandedNodes = 0;
  let nodeBudgetExceeded = false;
  const report = (code: CompilerDiagnostic["code"], message: string, module: YangModule, source: YangStatement) =>
    diagnostics.push({ code, message, module: module.argument, source });
  const singletonChildren: Readonly<Record<string, readonly string[]>> = {
    module: ["yang-version", "namespace", "prefix", "organization", "contact", "description", "reference"],
    submodule: ["yang-version", "belongs-to", "organization", "contact", "description", "reference"],
    "belongs-to": ["prefix"], "leaf": ["type", "units", "default", "config", "mandatory", "status", "description", "reference", "when"],
    "leaf-list": ["type", "units", "config", "min-elements", "max-elements", "ordered-by", "status", "description", "reference", "when"],
    typedef: ["type", "units", "default", "status", "description", "reference"],
    type: ["range", "length", "path", "require-instance", "fraction-digits"],
    container: ["presence", "config", "status", "description", "reference", "when"],
    list: ["key", "config", "min-elements", "max-elements", "ordered-by", "status", "description", "reference", "when"],
    choice: ["default", "config", "mandatory", "status", "description", "reference", "when"],
    case: ["status", "description", "reference", "when"],
    rpc: ["input", "output", "status", "description", "reference"],
    action: ["input", "output", "status", "description", "reference"],
    notification: ["status", "description", "reference"],
    enum: ["value", "status", "description", "reference"], bit: ["position", "status", "description", "reference"],
    augment: ["when", "description", "reference"],
  };
  const requiredChildren: Readonly<Record<string, readonly string[]>> = {
    module: ["namespace", "prefix"], submodule: ["belongs-to"], typedef: ["type"],
    leaf: ["type"], "leaf-list": ["type"], "belongs-to": ["prefix"],
  };
  const validateCardinality = (root: YangModule): void => {
    const visit = (statement: YangStatement, owner: YangModule): void => {
      for (const keyword of singletonChildren[statement.keyword] ?? []) {
        const occurrences = childrenOf(statement, keyword);
        if (occurrences.length > 1) for (const duplicate of occurrences.slice(1)) {
          report("invalid-statement-cardinality", `Statement '${keyword}' may appear at most once under '${statement.keyword}'`, root, duplicate);
        }
      }
      for (const keyword of requiredChildren[statement.keyword] ?? []) if (childrenOf(statement, keyword).length === 0) {
        report("invalid-statement-cardinality", `Statement '${keyword}' is required under '${statement.keyword}'`, root, statement);
      }
      if (statement.keyword === "type") {
        const typeName = statement.argument ?? "";
        const required = typeName === "decimal64" ? "fraction-digits"
          : typeName === "leafref" ? "path"
          : typeName === "enumeration" ? "enum"
          : typeName === "bits" ? "bit"
          : typeName === "union" ? "type"
          : typeName === "identityref" ? "base" : undefined;
        if (required && childrenOf(statement, required).length === 0) {
          report("invalid-statement-cardinality", `Statement '${required}' is required for type '${typeName}'`, root, statement);
        }
        // RFC 7950 section 9.2.1: a restriction is only legal for the built-in
        // type it derives from, resolved through the full typedef chain.
        const builtinType = resolveBuiltinQuietly(owner, statement);
        for (const child of statement.children) {
          const allowed = RESTRICTION_BUILTINS[child.keyword];
          if (!allowed || !builtinType) continue;
          if (!allowed.has(builtinType)) {
            report("invalid-type-restriction", `Restriction '${child.keyword}' is not valid for type '${typeName}' of kind '${builtinType}'`, root, child);
          }
        }
      }
      statement.children.forEach(child => visit(child, owner));
    };
    visit(root, root);
  };
  /** Resolve a type reference to its underlying built-in name without emitting diagnostics. */
  const resolveBuiltinQuietly = (owner: YangModule, type: YangStatement, seen: ReadonlySet<string> = new Set(), scope: readonly ScopeLevel[] = []): string | undefined => {
    const name = type.argument ?? "";
    if (builtinTypes.has(name)) return name;
    const entry = name.includes(":")
      ? (() => {
        const resolved = resolveQName(owner, name, modules, submodules);
        return resolved ? familyIndexOf(resolved.module).typedefs.get(resolved.name) : undefined;
      })()
      : findSymbol("typedef", scope, owner, name);
    if (!entry) return undefined;
    const key = `${moduleId(entry.document)}:${entry.statement.argument ?? ""}`;
    if (seen.has(key)) return undefined;
    const baseType = childOf(entry.statement, "type");
    if (!baseType) return undefined;
    return resolveBuiltinQuietly(entry.document, baseType, new Set([...seen, key]), entry.scope);
  };
  const checkDuplicates = (nodes: readonly CompiledSchemaNode[], owner: YangModule) => {
    const seen = new Set<string>();
    for (const node of nodes) {
      const key = `${node.module}:${node.name}`;
      if (seen.has(key)) report("duplicate-node", `Duplicate schema node '${key}'`, owner, node.source);
      seen.add(key);
    }
  };
  const submodulesFor = (module: YangModule): YangModule[] => submodules.filter(submodule =>
    childOf(submodule, "belongs-to")?.argument === module.argument,
  );
  const parentModuleFor = (context: YangModule): YangModule => {
    const parentName = childOf(context, "belongs-to")?.argument;
    return parentName ? modules.find(module => module.argument === parentName) ?? context : context;
  };
  const relatedSources = (context: YangModule): YangModule[] => {
    const parent = parentModuleFor(context);
    return [parent, ...submodulesFor(parent)];
  };
  const canonicalModule = (context: YangModule): YangModule => parentModuleFor(context);
  /** One enclosing grouping level of a scope chain, with its declaring document for prefix resolution. */
  type ScopeLevel = { statement: YangStatement; document: YangModule };
  interface SymbolEntry { statement: YangStatement; document: YangModule; scope: readonly ScopeLevel[]; }
  interface FamilyIndex { typedefs: Map<string, SymbolEntry>; groupings: Map<string, SymbolEntry>; }
  // Per-module-family index of TOP-LEVEL symbols (RFC 7950 §6.2.1): built
  // once instead of walking whole documents per reference.
  const familyIndexes = new Map<string, FamilyIndex>();
  const familyIndexOf = (module: YangModule): FamilyIndex => {
    const parent = parentModuleFor(module);
    const key = moduleId(parent);
    let index = familyIndexes.get(key);
    if (!index) {
      index = { typedefs: new Map(), groupings: new Map() };
      for (const source of [parent, ...submodulesFor(parent)]) {
        for (const child of source.children) {
          if (child.keyword === "typedef" && child.argument) index.typedefs.set(child.argument, { statement: child, document: source, scope: [] });
          if (child.keyword === "grouping" && child.argument) index.groupings.set(child.argument, { statement: child, document: source, scope: [] });
        }
      }
      familyIndexes.set(key, index);
    }
    return index;
  };
  /**
   * Scoped symbol lookup (RFC 7950 §6.2.1): declarations nested in an
   * enclosing grouping are visible only within that grouping, innermost
   * shadows outer and shadows top-level; a module's own prefix and its
   * imports resolve in the declaring document.
   */
  const findSymbol = (kind: "typedef" | "grouping", scope: readonly ScopeLevel[], module: YangModule, name: string): SymbolEntry | undefined => {
    for (let index = scope.length - 1; index >= 0; index--) {
      const found = scope[index]!.statement.children.find(child => child.keyword === kind && child.argument === name);
      if (found) return { statement: found, document: scope[index]!.document, scope: scope.slice(0, index + 1) };
    }
    return familyIndexOf(module)[kind === "typedef" ? "typedefs" : "groupings"].get(name);
  };
  const builtinTypes = BUILTIN_TYPES;
  const featureCache = new Map<string, boolean>();
  const featureExists = (module: YangModule, name: string) => relatedSources(module).some(source =>
    childrenOf(source, "feature").some(feature => feature.argument === name),
  );
  const evaluateFeature = (moduleName: string, expression: string, source: YangStatement): boolean => {
    const cacheKey = `${moduleName}:${expression}`;
    if (featureCache.has(cacheKey)) return featureCache.get(cacheKey)!;
    const context = [...modules, ...submodules].find(module => module.argument === moduleName);
    if (!context) return false;
    const tokens = expression.match(/[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?|[()]/g) ?? [];
    if (tokens.join("") !== expression.replace(/\s+/g, "")) {
      report("invalid-feature-expression", `Invalid if-feature expression '${expression}'`, context, source);
      featureCache.set(cacheKey, false);
      return false;
    }
    let index = 0;
    const peek = () => tokens[index];
    const primary = (): boolean => {
      if (peek() === "not") { index++; return !primary(); }
      if (peek() === "(") {
        index++;
        const value = disjunction();
        if (peek() !== ")") throw new Error("Missing closing parenthesis");
        index++;
        return value;
      }
      const token = tokens[index++];
      if (!token || token === "and" || token === "or" || token === ")") throw new Error("Expected feature identifier");
      const resolved = resolveQName(context, token, modules, submodules);
      if (!resolved || !featureExists(resolved.module, resolved.name)) {
        report("unresolved-feature", `Feature '${token}' could not be resolved`, context, source);
        return false;
      }
      return Boolean(options.enabledFeatures?.has(`${canonicalModule(resolved.module).argument}:${resolved.name}`));
    };
    const conjunction = (): boolean => {
      let value = primary();
      while (peek() === "and") { index++; const right = primary(); value = value && right; }
      return value;
    };
    const disjunction = (): boolean => {
      let value = conjunction();
      while (peek() === "or") { index++; const right = conjunction(); value = value || right; }
      return value;
    };
    try {
      const value = disjunction();
      if (index !== tokens.length) throw new Error("Unexpected token");
      featureCache.set(cacheKey, value);
      return value;
    } catch {
      report("invalid-feature-expression", `Invalid if-feature expression '${expression}'`, context, source);
      featureCache.set(cacheKey, false);
      return false;
    }
  };
  const featureRequirementsEnabled = (requirements: readonly { module: string; expression: string; source: YangStatement }[]) =>
    requirements.every(requirement => evaluateFeature(requirement.module, requirement.expression, requirement.source));
  const resolveType = (owner: YangModule, type: YangStatement, stack: readonly string[] = [], scope: readonly ScopeLevel[] = []): { name?: string; chain: YangStatement[]; chainModules: string[] } => {
    const typeName = type.argument ?? "";
    if (builtinTypes.has(typeName)) return { name: typeName, chain: [], chainModules: [] };
    const entry = typeName.includes(":")
      ? (() => {
        const resolved = resolveQName(owner, typeName, modules, submodules);
        return resolved ? familyIndexOf(resolved.module).typedefs.get(resolved.name) : undefined;
      })()
      : findSymbol("typedef", scope, owner, typeName);
    if (!entry) return { chain: [], chainModules: [] };
    const key = `${moduleId(entry.document)}:${entry.statement.argument ?? ""}`;
    if (stack.includes(key)) {
      report("typedef-cycle", `Typedef cycle: ${[...stack, key].join(" -> ")}`, owner, type);
      return { chain: [], chainModules: [] };
    }
    const baseType = childOf(entry.statement, "type");
    if (!baseType) return { chain: [], chainModules: [] };
    const base = resolveType(entry.document, baseType, [...stack, key], entry.scope);
    // chainModules[i] names the module that declared chain[i] so callers can
    // compile statements nested in each typedef (e.g. leafref paths) in the
    // typedef's own prefix context, whatever module ends up using the type.
    return {
      ...(base.name ? { name: base.name } : {}),
      chain: [entry.statement, ...base.chain],
      chainModules: [entry.document.argument ?? "", ...base.chainModules],
    };
  };
  for (const module of modules) for (const source of [module, ...submodulesFor(module)]) validateCardinality(source);

  /** A `when` statement and the schema path of the node it constrains (RFC 7950 §7.21.5 context). */
  type WhenOrigin = { statement: YangStatement; holder: string };
  const makeNode = (
    statement: YangStatement, owner: YangModule, parentPath: string, inheritedConfig: boolean,
    groupingStack: readonly ScopeLevel[] = [], inheritedWhen: readonly WhenOrigin[] = [],
    inheritedFeatures: readonly { module: string; expression: string; source: YangStatement }[] = [],
    instantiatingModule: YangModule = owner,
    // Prefixes of type/uses references resolve in the document that carries the
    // statement (module or submodule, RFC 7950 §5.6.2), not in the namespace module.
    sourceModule: YangModule = owner,
  ): CompiledSchemaNode[] => {
    expandedNodes++;
    const maxSchemaNodes = options.budget?.maxSchemaNodes;
    if (maxSchemaNodes !== undefined && (expandedNodes > maxSchemaNodes && !nodeBudgetExceeded)) {
      nodeBudgetExceeded = true;
      report("budget-exceeded", `Schema node budget ${maxSchemaNodes} exceeded while expanding '${statement.keyword}${statement.argument ? ` ${statement.argument}` : ""}'`, owner, statement);
    }
    if (nodeBudgetExceeded) return [];
    if (statement.keyword === "uses") {
      const rawName = statement.argument ?? "";
      // Grouping references resolve with the RFC 7950 §6.2.1 scope of the
      // statement itself: unqualified names look through the enclosing
      // grouping levels first, then the module family's top level; qualified
      // names address the family (groupings are never imported).
      const entry = rawName.includes(":")
        ? (() => {
          const resolved = resolveQName(sourceModule, rawName, modules, submodules);
          return resolved ? familyIndexOf(resolved.module).groupings.get(resolved.name) : undefined;
        })()
        : findSymbol("grouping", groupingStack, sourceModule, rawName);
      if (!entry) { report("unresolved-grouping", `Grouping '${rawName}' was not found`, owner, statement); return []; }
      if (groupingStack.some(level => level.statement === entry.statement)) {
        report("uses-cycle", `Grouping uses cycle: ${[...groupingStack.map(level => level.statement.argument ?? ""), rawName].join(" -> ")}`, owner, statement);
        return [];
      }
      const childScope = [...entry.scope, { statement: entry.statement, document: entry.document }];
      const features = [...inheritedFeatures, ...childrenOf(statement, "if-feature").map(item => ({ module: owner.argument, expression: item.argument ?? "", source: item }))];
      if (options.enabledFeatures && !featureRequirementsEnabled(features)) return [];
      const when = [...inheritedWhen, ...childrenOf(statement, "when").map(item => ({ statement: item, holder: parentPath }))];
      const expanded = dataChildren(entry.statement).flatMap(child => makeNode(child, entry.document, parentPath, inheritedConfig, childScope, when, features, instantiatingModule, entry.document));
      const refineAllowed: Record<string, ReadonlySet<string>> = {
        // RFC 7950 §7.13.2: a refine may change a leaf's mandatory statement.
        leaf: new Set(["default", "description", "reference", "config", "mandatory", "must", "if-feature"]),
        "leaf-list": new Set(["default", "description", "reference", "config", "min-elements", "max-elements", "must", "if-feature"]),
        list: new Set(["description", "reference", "config", "min-elements", "max-elements", "must", "if-feature"]),
        container: new Set(["description", "reference", "config", "presence", "must", "if-feature"]),
        choice: new Set(["default", "description", "reference", "config", "mandatory", "if-feature"]),
        case: new Set(["description", "reference", "if-feature"]),
        anydata: new Set(["description", "reference", "config", "mandatory", "must", "if-feature"]),
        anyxml: new Set(["description", "reference", "config", "mandatory", "must", "if-feature"]),
      };
      const findRelative = (nodes: CompiledSchemaNode[], names: string[]): CompiledSchemaNode | undefined => {
        let siblings = nodes;
        let found: CompiledSchemaNode | undefined;
        for (const name of names) {
          found = siblings.find(node => node.name === name);
          if (!found) return undefined;
          siblings = found.children;
        }
        return found;
      };
      for (const refine of childrenOf(statement, "refine")) {
        const target = findRelative(expanded, (refine.argument ?? "").split("/").filter(Boolean));
        if (!target) { report("unresolved-refine", `Refine target '${refine.argument ?? ""}' was not found in grouping '${entry.statement.argument ?? ""}'`, owner, refine); continue; }
        const allowed = refineAllowed[target.kind];
        for (const property of refine.children) {
          if (!allowed?.has(property.keyword)) { report("invalid-refine", `Property '${property.keyword}' cannot refine a '${target.kind}' node`, owner, property); continue; }
          if (property.keyword === "must" || property.keyword === "if-feature") {
            target.properties[property.keyword] = [...(target.properties[property.keyword] ?? []), property];
          } else {
            target.properties[property.keyword] = [property];
          }
        }
        if (target.kind === "leaf-list" && refine.children.some(property => property.keyword === "default")) {
          target.properties.default = refine.children.filter(property => property.keyword === "default");
        }
        target.must = target.properties.must ?? [];
        const refinedFeatures = (target.properties["if-feature"] ?? []).map(feature => ({ module: owner.argument, expression: feature.argument ?? "", source: feature }));
        target.featureRequirements = [...target.featureRequirements, ...refinedFeatures.map(({ module, expression }) => ({ module, expression }))];
        target.ifFeatures = [...target.ifFeatures, ...refinedFeatures.map(feature => feature.expression)];
      }
      // RFC 7950 §7.17: an augment inside uses adds nodes to a target inside
      // the expanded grouping (target relative to the grouping instance);
      // the uses' when/if-feature apply to the additions as well.
      for (const augment of childrenOf(statement, "augment")) {
        const target = findRelative(expanded, (augment.argument ?? "").split("/").filter(Boolean));
        if (!target) { report("unresolved-augment", `Augment target '${augment.argument ?? ""}' was not found in grouping '${entry.statement.argument ?? ""}'`, owner, augment); continue; }
        if (!["container", "list", "choice", "case"].includes(target.kind)) {
          report("invalid-augment-target", `Node '${target.path}' of kind '${target.kind}' cannot be augmented`, owner, augment);
          continue;
        }
        const augmentWhen = [...when, ...childrenOf(augment, "when").map(item => ({ statement: item, holder: target.path }))];
        const augmentFeatures = [...features, ...childrenOf(augment, "if-feature").map(feature => ({ module: owner.argument, expression: feature.argument ?? "", source: feature }))];
        if (options.enabledFeatures && !featureRequirementsEnabled(augmentFeatures)) continue;
        const additions = normalizeChoiceChildren(
          augment.children
            .filter(child => DATA_KINDS.has(child.keyword as SchemaNodeKind)
              || child.keyword === "uses" || child.keyword === "action" || child.keyword === "notification")
            .flatMap(child => makeNode(child, instantiatingModule, target.path, target.config, childScope, augmentWhen, augmentFeatures, instantiatingModule, sourceModule)),
          target,
        );
        for (const addition of additions) {
          if (target.children.some(child => child.module === addition.module && child.name === addition.name)) {
            report("augment-conflict", `Augment adds duplicate node '${addition.name}' at '${target.path}'`, owner, addition.source);
          } else target.children.push(addition);
        }
        checkDuplicates(target.children, owner);
      }
      const keepEnabledFeatures = (nodes: CompiledSchemaNode[]): CompiledSchemaNode[] => nodes.flatMap(node => {
        const requirements = node.featureRequirements.map(requirement => ({ ...requirement, source: node.source }));
        if (options.enabledFeatures && !featureRequirementsEnabled(requirements)) return [];
        node.children = keepEnabledFeatures(node.children);
        return [node];
      });
      return keepEnabledFeatures(expanded);
    }
    if (!DATA_KINDS.has(statement.keyword as SchemaNodeKind)) return [];
    const kind = statement.keyword as SchemaNodeKind;
    const name = statement.argument ?? "";
    const nodeFeatureRequirements = [...inheritedFeatures, ...childrenOf(statement, "if-feature").map(item => ({ module: owner.argument, expression: item.argument ?? "", source: item }))];
    if (options.enabledFeatures && !featureRequirementsEnabled(nodeFeatureRequirements)) return [];
    const path = `${parentPath}/${name}`;
    const configStatement = childOf(statement, "config")?.argument;
    const config = configStatement === "false" ? false : configStatement === "true" ? true : inheritedConfig;
    const keys = (childOf(statement, "key")?.argument ?? "").split(/\s+/).filter(Boolean);
    const nodeWhen = [...inheritedWhen, ...childrenOf(statement, "when").map(item => ({ statement: item, holder: path }))];
    const nodeFeatures = nodeFeatureRequirements.map(requirement => requirement.expression);
    const typeStatement = childOf(statement, "type");
    const resolvedType = typeStatement ? resolveType(sourceModule, typeStatement, [], groupingStack) : undefined;
    if (typeStatement && !resolvedType?.name) report("unresolved-type", `Type '${typeStatement.argument ?? ""}' could not be resolved`, owner, typeStatement);
    const node: CompiledSchemaNode = {
      kind, name, module: instantiatingModule.argument, namespace: childOf(instantiatingModule, "namespace")?.argument ?? "",
      path, config, keys,
      ...(typeStatement ? { type: typeStatement } : {}),
      ...(resolvedType?.name ? { resolvedType: resolvedType.name } : {}),
      typedefChain: resolvedType?.chain ?? [],
      typedefChainModules: resolvedType?.chainModules ?? [],
      must: childrenOf(statement, "must"),
      whenConstraints: nodeWhen.map(origin => origin.statement),
      whenHolders: nodeWhen.map(origin => origin.holder),
      ifFeatures: nodeFeatures,
      featureRequirements: nodeFeatureRequirements.map(({ module, expression }) => ({ module, expression })),
      properties: statement.children.reduce<Record<string, YangStatement[]>>((properties, child) => {
        if (DATA_KINDS.has(child.keyword as SchemaNodeKind) || child.keyword === "uses") return properties;
        (properties[child.keyword] ??= []).push(child);
        return properties;
      }, {}),
      deviations: [],
      source: statement, children: [],
    };
    // Nested nodes belong to the instantiating module too: only the grouping's
    // defining module resolves their type/prefix references, not their
    // namespace. Inherited when/if-feature keep propagating from the parent.
    // RFC 7950 §6.2.1: definitions declared inside this data node are visible
    // only to it and its descendants, so the node itself becomes a scope level
    // for its children (innermost levels are searched first and shadow outer
    // and top-level ones).
    const kindScopesSymbols = ["container", "list", "grouping", "rpc", "action", "notification", "input", "output"].includes(kind);
    const childGroupingStack = kindScopesSymbols ? [...groupingStack, { statement, document: sourceModule }] : groupingStack;
    node.children = normalizeChoiceChildren(
      dataChildren(statement).flatMap(child =>
        makeNode(child, owner, path, config, childGroupingStack, nodeWhen, nodeFeatureRequirements, instantiatingModule, sourceModule)),
      node,
    );
    if (kind === "list") {
      for (const key of keys) {
        const resolvedKey = resolveQName(instantiatingModule, key, modules, submodules);
        const keyLeaf = resolvedKey && node.children.find(child =>
          child.kind === "leaf" && child.name === resolvedKey.name && child.module === resolvedKey.module.argument,
        );
        if (!keyLeaf) {
          report("invalid-key", `List key '${key}' is not a direct leaf of '${path}'`, owner, statement);
        } else if (keyLeaf.config !== node.config) {
          report("invalid-key", `List key '${key}' must have the same config value as its list`, owner, keyLeaf.source);
        }
      }
    }
    checkDuplicates(node.children, owner);
    return [node];
  };

  // RFC 7950 section 7.9.2: shorthand children of a choice still have a
  // case node in the schema tree. Keep it explicit in the IR so schema paths,
  // augments and UI consumers all see the same effective tree.
  const normalizeChoiceChildren = (children: CompiledSchemaNode[], parent: CompiledSchemaNode): CompiledSchemaNode[] => {
    if (parent.kind !== "choice") return children;
    return children.map(child => {
      if (child.kind === "case") return child;
      const path = `${parent.path}/${child.name}`;
      const rebase = (node: CompiledSchemaNode, oldPrefix: string, newPrefix: string): void => {
        node.path = `${newPrefix}${node.path.slice(oldPrefix.length)}`;
        for (const descendant of node.children) rebase(descendant, oldPrefix, newPrefix);
      };
      rebase(child, child.path, `${path}/${child.name}`);
      return {
        kind: "case", name: child.name, module: child.module, namespace: child.namespace,
        path, config: child.config, keys: [], typedefChain: [], typedefChainModules: [], must: [], whenConstraints: [], whenHolders: [],
        ifFeatures: [], featureRequirements: [], properties: {}, deviations: [], source: child.source,
        children: [child],
      };
    });
  };

  for (const module of modules) {
    const ownerStatements = [module, ...submodulesFor(module)];
    for (const owner of ownerStatements) {
      for (const statement of dataChildren(owner)) roots.push(...makeNode(statement, module, "", true, [], [], [], module, owner));
    }
  }
  for (const module of modules) checkDuplicates(roots.filter(node => node.module === module.argument), module);

  const qnamePath = (module: YangModule, path: string): Array<{ module: YangModule; name: string }> | undefined => {
    const parts = path.split("/").filter(Boolean);
    const resolved = parts.map(part => resolveQName(module, part, modules, submodules));
    return resolved.every(Boolean) ? resolved as Array<{ module: YangModule; name: string }> : undefined;
  };
  const findTarget = (path: Array<{ module: YangModule; name: string }>): CompiledSchemaNode | undefined => {
    let siblings = roots;
    let result: CompiledSchemaNode | undefined;
    for (const part of path) {
      result = siblings.find(node => node.module === part.module.argument && node.name === part.name);
      if (!result) return undefined;
      siblings = result.children;
    }
    return result;
  };
  const pendingAugmentActions: Array<{ module: YangModule; statement: YangStatement; parentPath: string; schemaPath: readonly { module: string; name: string }[]; source: YangModule }> = [];
  const pendingAugmentNotifications: Array<{ module: YangModule; statement: YangStatement; parentPath: string; schemaPath: readonly { module: string; name: string }[]; source: YangModule }> = [];
  const operationAugments: Array<{ module: YangModule; statement: YangStatement; target: Array<{ module: YangModule; name: string }>; scope: "input" | "output" | "data"; source: YangModule }> = [];
  const augments = modules.flatMap(module => [module, ...submodulesFor(module)].flatMap(source =>
    childrenOf(source, "augment").map(statement => ({ module, source, statement })),
  ));
  const pending = [...augments];
  let madeProgress = true;
  while (pending.length && madeProgress) {
    madeProgress = false;
    for (let index = pending.length - 1; index >= 0; index--) {
      const item = pending[index]!;
      const path = qnamePath(item.source, item.statement.argument ?? "");
      if (!path) { report("unresolved-prefix", `Cannot resolve augment path '${item.statement.argument ?? ""}'`, item.module, item.statement); pending.splice(index, 1); continue; }
      const target = findTarget(path);
      if (!target) {
        const last = path[path.length - 1];
        const notificationTarget = path.length === 1 && path[0] && [...modules.flatMap(module => [module, ...submodulesFor(module)])].some(source =>
          childrenOf(source, "notification").some(notification => notification.argument === last?.name)
            && canonicalModule(source).argument === last?.module.argument,
        );
        if (last && (last.name === "input" || last.name === "output" || notificationTarget)) {
          operationAugments.push({
            module: item.module, statement: item.statement, target: path,
            scope: last.name === "input" || last.name === "output" ? last.name : "data", source: item.source,
          });
          pending.splice(index, 1);
          madeProgress = true;
        }
        continue;
      }
      const augmentWhen = childrenOf(item.statement, "when").map(item2 => ({ statement: item2, holder: target.path }));
      const augmentFeatures = childrenOf(item.statement, "if-feature").map(feature => ({ module: item.module.argument, expression: feature.argument ?? "", source: feature }));
      if (options.enabledFeatures && !featureRequirementsEnabled(augmentFeatures)) { pending.splice(index, 1); madeProgress = true; continue; }
      if (!["container", "list", "choice", "case"].includes(target.kind)) {
        report("invalid-augment-target", `Node '${target.path}' of kind '${target.kind}' cannot be augmented`, item.module, item.statement);
        pending.splice(index, 1); madeProgress = true; continue;
      }
      const isAllowedAugmentChild = (keyword: string): boolean => {
        if (target.kind === "choice") return ["case", "anydata", "anyxml", "choice", "container", "leaf", "leaf-list", "list", "uses"].includes(keyword);
        if (target.kind === "container" || target.kind === "list") return ["action", "notification", "choice", "container", "leaf", "leaf-list", "list", "uses"].includes(keyword);
        return ["choice", "container", "leaf", "leaf-list", "list", "uses"].includes(keyword);
      };
      const augmentChildren = item.statement.children.filter(child => {
        if (isAllowedAugmentChild(child.keyword)) return true;
        if (DATA_KINDS.has(child.keyword as SchemaNodeKind) || child.keyword === "uses" || child.keyword === "action" || child.keyword === "notification") {
          report("invalid-augment-child", `Statement '${child.keyword}' cannot be added to a '${target.kind}' node`, item.module, child);
        }
        return false;
      });
      const additions = normalizeChoiceChildren(augmentChildren.flatMap(child => makeNode(child, item.module, target.path, target.config, [], augmentWhen, augmentFeatures, item.module, item.source)), target);
      if (target.kind === "container" || target.kind === "list") {
        for (const action of childrenOf(item.statement, "action")) pendingAugmentActions.push({
          module: item.module, statement: action, parentPath: target.path,
          schemaPath: path.map(part => ({ module: part.module.argument, name: part.name })), source: item.source,
        });
        for (const notification of childrenOf(item.statement, "notification")) pendingAugmentNotifications.push({
          module: item.module, statement: notification, parentPath: target.path,
          schemaPath: path.map(part => ({ module: part.module.argument, name: part.name })), source: item.source,
        });
      }
      for (const addition of additions) {
        if (target.children.some(child => child.module === addition.module && child.name === addition.name)) {
          report("augment-conflict", `Augment adds duplicate node '${addition.name}' at '${target.path}'`, item.module, addition.source);
        } else target.children.push(addition);
      }
      checkDuplicates(target.children, item.module);
      pending.splice(index, 1);
      madeProgress = true;
    }
  }
  for (const item of pending) report("unresolved-augment", `Augment target '${item.statement.argument ?? ""}' was not found`, item.module, item.statement);

  const locateTarget = (path: Array<{ module: YangModule; name: string }>) => {
    let siblings = roots;
    for (const part of path) {
      const index = siblings.findIndex(node => node.module === part.module.argument && node.name === part.name);
      if (index < 0) return undefined;
      const node = siblings[index]!;
      if (part === path[path.length - 1]) return { siblings, index, node };
      siblings = node.children;
    }
    return undefined;
  };
  const deviableProperties = new Set(["config", "default", "mandatory", "max-elements", "min-elements", "must", "type", "unique", "units"]);
  const repeatableProperty = (node: CompiledSchemaNode, property: string) =>
    property === "must" || property === "unique" || (property === "default" && node.kind === "leaf-list");
  const deviationSources = modules.flatMap(module => [module, ...submodulesFor(module)].flatMap(source =>
    childrenOf(source, "deviation").map(statement => ({ module, source, statement })),
  ));
  for (const { module, source, statement } of deviationSources) {
    const path = qnamePath(source, statement.argument ?? "");
    const targetLocation = path && locateTarget(path);
    if (!targetLocation) {
      report("unresolved-deviation", `Deviation target '${statement.argument ?? ""}' was not found`, module, statement);
      continue;
    }
    const { siblings, index, node } = targetLocation;
    node.deviations.push(statement);
    let removed = false;
    for (const deviate of childrenOf(statement, "deviate")) {
      const action = deviate.argument;
      if (action === "not-supported") { siblings.splice(index, 1); removed = true; break; }
      if (action !== "add" && action !== "replace" && action !== "delete") {
        report("invalid-deviation", `Unknown deviate operation '${action ?? ""}'`, module, deviate);
        continue;
      }
      for (const property of deviate.children) {
        if (!deviableProperties.has(property.keyword)) {
          report("invalid-deviation", `Property '${property.keyword}' cannot be changed by a deviation`, module, property);
          continue;
        }
        const current = node.properties[property.keyword] ?? [];
        if (action === "add") {
          if (!repeatableProperty(node, property.keyword) && current.length > 0) {
            report("invalid-deviation", `Cannot add '${property.keyword}': the property already exists`, module, property);
            continue;
          }
          node.properties[property.keyword] = [...current, property];
        } else if (action === "replace") {
          if (current.length === 0) {
            report("invalid-deviation", `Cannot replace '${property.keyword}': the property does not exist`, module, property);
            continue;
          }
          node.properties[property.keyword] = [...deviate.children.filter(child => child.keyword === property.keyword)];
        } else {
          const match = current.findIndex(existing => existing.argument === property.argument);
          if (match < 0) {
            report("invalid-deviation", `Cannot delete '${property.keyword} ${property.argument ?? ""}': no matching property exists`, module, property);
            continue;
          }
          node.properties[property.keyword] = current.filter((_, currentIndex) => currentIndex !== match);
        }
      }
    }
    if (removed) continue;
    node.must = node.properties.must ?? [];
    const replacementType = node.properties.type?.[0];
    if (replacementType) {
      node.type = replacementType;
      const resolved = resolveType(module, replacementType);
      if (!resolved.name) report("invalid-deviation", `Replacement type '${replacementType.argument ?? ""}' could not be resolved`, module, replacementType);
      else {
        node.resolvedType = resolved.name;
        node.typedefChain = resolved.chain;
        node.typedefChainModules = resolved.chainModules;
      }
    }
  }
  const refreshConfig = (node: CompiledSchemaNode, inheritedConfig: boolean) => {
    const ownConfig = node.properties.config?.[0]?.argument;
    node.config = ownConfig === "true" ? true : ownConfig === "false" ? false : inheritedConfig;
    node.children.forEach(child => refreshConfig(child, node.config));
  };
  roots.forEach(node => refreshConfig(node, true));

  const operations: CompiledOperation[] = [];
  const compileOperation = (
    module: YangModule, statement: YangStatement, parentPath = "",
    parentSchemaPath: readonly { module: string; name: string }[] = [],
    sourceModule: YangModule = module,
  ) => {
    if (statement.keyword !== "rpc" && statement.keyword !== "action" && statement.keyword !== "notification") return;
    const operationPath = `${parentPath}/${statement.argument ?? ""}`;
    // RFC 7950 §6.2.1: the operation and its input/output each scope the
    // definitions declared inside them to themselves and their descendants.
    const operationScope: ScopeLevel[] = [{ statement, document: sourceModule }];
    const compileScope = (scope: YangStatement | undefined, name: "input" | "output") => scope
      ? dataChildren(scope).flatMap(child => makeNode(child, module, `${operationPath}/${name}`, true,
        [...operationScope, { statement: scope, document: sourceModule }], [], [], module, sourceModule))
      : [];
    const data = statement.keyword === "notification"
      ? dataChildren(statement).flatMap(child => makeNode(child, module, operationPath, false, operationScope, [], [], module, sourceModule))
      : [];
    operations.push({
      kind: statement.keyword, name: statement.argument ?? "", module: module.argument, path: operationPath, source: statement,
      schemaPath: [...parentSchemaPath, { module: module.argument, name: statement.argument ?? "" }],
      data,
      input: compileScope(childOf(statement, "input"), "input"), output: compileScope(childOf(statement, "output"), "output"),
    });
  };
  for (const module of modules) {
    for (const source of [module, ...submodulesFor(module)]) {
      for (const statement of source.children) {
        if (statement.keyword === "rpc" || statement.keyword === "notification") compileOperation(module, statement, "", [], source);
      }
    }
  }
  const collectNestedActions = (nodes: readonly CompiledSchemaNode[], parentSchemaPath: readonly { module: string; name: string }[] = []) => {
    for (const node of nodes) {
      const operationModule = modules.find(module => module.argument === node.module);
      const nodeSchemaPath = [...parentSchemaPath, { module: node.module, name: node.name }];
      if (operationModule) for (const action of childrenOf(node.source, "action")) compileOperation(operationModule, action, node.path, nodeSchemaPath);
      collectNestedActions(node.children, nodeSchemaPath);
    }
  };
  collectNestedActions(roots);
  for (const action of pendingAugmentActions) {
    compileOperation(action.module, action.statement, action.parentPath, action.schemaPath, action.source);
  }
  for (const notification of pendingAugmentNotifications) {
    compileOperation(notification.module, notification.statement, notification.parentPath, notification.schemaPath, notification.source);
  }
  for (const augment of operationAugments) {
    const targetSchemaPath = (augment.scope === "data" ? augment.target : augment.target.slice(0, -1))
      .map(part => ({ module: part.module.argument, name: part.name }));
    const operation = operations.find(candidate => candidate.schemaPath.length === targetSchemaPath.length
      && (augment.scope !== "data" || candidate.kind === "notification")
      && candidate.schemaPath.every((part, index) => part.module === targetSchemaPath[index]?.module && part.name === targetSchemaPath[index]?.name));
    if (!operation) {
      report("unresolved-augment", `Augment target '${augment.statement.argument ?? ""}' was not found`, augment.module, augment.statement);
      continue;
    }
    const scope = augment.scope;
    const targetNodes = operation[scope];
    const targetPath = scope === "data" ? operation.path : `${operation.path}/${scope}`;
    const inheritedConfig = scope !== "data";
    const allowedChildren = new Set(["choice", "container", "leaf", "leaf-list", "list", "uses"]);
    const augmentChildren = augment.statement.children.filter(child => {
      if (allowedChildren.has(child.keyword)) return true;
      if (DATA_KINDS.has(child.keyword as SchemaNodeKind) || child.keyword === "uses" || child.keyword === "action" || child.keyword === "notification") {
        report("invalid-augment-child", `Statement '${child.keyword}' cannot be added to an operation parameter node`, augment.module, child);
      }
      return false;
    });
    const additions = augmentChildren.flatMap(child => makeNode(child, augment.module, targetPath, inheritedConfig, [], childrenOf(augment.statement, "when").map(item => ({ statement: item, holder: targetPath })), childrenOf(augment.statement, "if-feature").map(feature => ({ module: augment.module.argument, expression: feature.argument ?? "", source: feature })), augment.module, augment.source));
    for (const addition of additions) {
      if (targetNodes.some(child => child.module === addition.module && child.name === addition.name)) {
        report("augment-conflict", `Augment adds duplicate node '${addition.name}' at '${targetPath}'`, augment.module, addition.source);
      } else targetNodes.push(addition);
    }
    checkDuplicates(targetNodes, augment.module);
  }
  const identities: CompiledIdentity[] = [];
  for (const module of modules) {
    for (const source of [module, ...submodulesFor(module)]) {
      for (const statement of childrenOf(source, "identity")) {
        const requirements = childrenOf(statement, "if-feature").map(feature => ({ module: module.argument, expression: feature.argument ?? "", source: feature }));
        if (options.enabledFeatures && !featureRequirementsEnabled(requirements)) continue;
        const bases: string[] = [];
        for (const base of childrenOf(statement, "base")) {
      const resolved = resolveQName(source, base.argument ?? "", modules, submodules);
          if (!resolved) {
            report("unresolved-identity", `Identity base '${base.argument ?? ""}' could not be resolved`, module, base);
            continue;
          }
          bases.push(`${canonicalModule(resolved.module).argument}:${resolved.name}`);
        }
        identities.push({ name: statement.argument ?? "", module: module.argument, namespace: childOf(module, "namespace")?.argument ?? "", bases, source: statement });
      }
    }
  }
  const identityById = new Map(identities.map(identity => [`${identity.module}:${identity.name}`, identity]));
  for (const identity of identities) for (const base of identity.bases) {
    if (!identityById.has(base)) {
      const owner = modules.find(module => module.argument === identity.module)!;
      report("unresolved-identity", `Identity base '${base}' is not defined in the module set`, owner, identity.source);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const checkIdentityCycle = (identity: CompiledIdentity, chain: readonly string[] = []) => {
    const id = `${identity.module}:${identity.name}`;
    if (visiting.has(id)) {
      report("identity-cycle", `Identity inheritance cycle: ${[...chain, id].join(" -> ")}`, modules.find(module => module.argument === identity.module)!, identity.source);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const baseId of identity.bases) {
      const base = identityById.get(baseId);
      if (base) checkIdentityCycle(base, [...chain, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const identity of identities) checkIdentityCycle(identity);
  return { roots, operations, identities, diagnostics, modules, submodules };
}

/** Test transitive identity derivation using module-qualified `module:name` identities. */
export function isIdentityDerivedFrom(schema: CompiledYangSchema, identityRef: string, baseRef: string): boolean {
  const toIdentityId = (value: string): string | undefined => {
    const separator = value.indexOf(":");
    if (separator < 0) return undefined;
    const moduleName = value.slice(0, separator);
    const identityName = value.slice(separator + 1);
    const module = schema.modules.filter(candidate => candidate.argument === moduleName)
      .sort((a, b) => revisionOf(b).localeCompare(revisionOf(a)))[0];
    return module ? `${module.argument}:${identityName}` : undefined;
  };
  const target = toIdentityId(baseRef);
  const start = toIdentityId(identityRef);
  if (!target || !start || start === target) return false;
  const byId = new Map<string, CompiledIdentity>(schema.identities.map(identity => [`${identity.module}:${identity.name}`, identity]));
  const visited = new Set<string>();
  const pending = [...(byId.get(start)?.bases ?? [])];
  while (pending.length) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(byId.get(current)?.bases ?? []));
  }
  return false;
}
