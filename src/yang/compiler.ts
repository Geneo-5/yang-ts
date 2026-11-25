import { YangModule, YangStatement } from "./ast.js";
import { childOf, childrenOf } from "./parser.js";
import { YangModuleSet } from "./module-set.js";

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
  must: readonly YangStatement[];
  whenConstraints: readonly YangStatement[];
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
  source: YangStatement;
  input: CompiledSchemaNode[];
  output: CompiledSchemaNode[];
}
export interface CompilerDiagnostic {
  code: "duplicate-node" | "unresolved-prefix" | "unresolved-augment" | "unresolved-grouping" |
    "uses-cycle" | "augment-conflict" | "invalid-key" | "unresolved-type" | "typedef-cycle" |
    "unresolved-feature" | "invalid-feature-expression" | "unresolved-deviation" | "invalid-deviation" |
    "unresolved-refine" | "invalid-refine";
  message: string;
  module: string;
  source: YangStatement;
}
export interface CompiledYangSchema {
  roots: CompiledSchemaNode[];
  operations: CompiledOperation[];
  diagnostics: CompilerDiagnostic[];
  modules: readonly YangModule[];
}

export interface YangCompilerOptions {
  /** Feature identifiers use the declaring module name, e.g. `ietf-interfaces:arbitrary-names`. */
  enabledFeatures?: ReadonlySet<string>;
}

const DATA_KINDS = new Set<SchemaNodeKind>(["container", "list", "leaf", "leaf-list", "choice", "case", "anydata", "anyxml"]);
const revisionOf = (module: YangModule) => childOf(module, "revision")?.argument ?? "";
const moduleId = (module: YangModule) => `${module.argument}@${revisionOf(module)}`;

function importedModule(context: YangModule, prefix: string, modules: readonly YangModule[]): YangModule | undefined {
  if (childOf(context, "prefix")?.argument === prefix) return context;
  const importNode = childrenOf(context, "import").find(item => childOf(item, "prefix")?.argument === prefix);
  const name = importNode?.argument;
  return modules.find(candidate => candidate.argument === name);
}

function resolveQName(context: YangModule, qname: string, modules: readonly YangModule[]): { module: YangModule; name: string } | undefined {
  const split = qname.split(":");
  if (split.length === 1) return { module: context, name: split[0]! };
  if (split.length !== 2) return undefined;
  const module = importedModule(context, split[0]!, modules);
  return module ? { module, name: split[1]! } : undefined;
}

function dataChildren(node: YangStatement): YangStatement[] {
  return node.children.filter(child => DATA_KINDS.has(child.keyword as SchemaNodeKind) || child.keyword === "uses");
}

/** Compile data trees and apply schema-node augments; type and expression statements remain source-linked for later passes. */
export function compileYangModules(moduleSet: YangModuleSet, options: YangCompilerOptions = {}): CompiledYangSchema {
  const diagnostics: CompilerDiagnostic[] = [];
  const modules = moduleSet.modules;
  const roots: CompiledSchemaNode[] = [];
  const report = (code: CompilerDiagnostic["code"], message: string, module: YangModule, source: YangStatement) =>
    diagnostics.push({ code, message, module: module.argument, source });
  const checkDuplicates = (nodes: readonly CompiledSchemaNode[], owner: YangModule) => {
    const seen = new Set<string>();
    for (const node of nodes) {
      const key = `${node.module}:${node.name}`;
      if (seen.has(key)) report("duplicate-node", `Duplicate schema node '${key}'`, owner, node.source);
      seen.add(key);
    }
  };
  const submodulesFor = (module: YangModule): YangModule[] => moduleSet.submodules.filter(submodule =>
    childOf(submodule, "belongs-to")?.argument === module.argument,
  );
  const findTypedef = (module: YangModule, name: string): YangStatement | undefined => {
    const visit = (statement: YangStatement): YangStatement | undefined => {
      for (const child of statement.children) {
        if (child.keyword === "typedef" && child.argument === name) return child;
        const nested = visit(child);
        if (nested) return nested;
      }
      return undefined;
    };
    return [module, ...submodulesFor(module)].map(visit).find(Boolean);
  };
  const builtinTypes = new Set([
    "binary", "bits", "boolean", "decimal64", "empty", "enumeration", "identityref", "instance-identifier",
    "int8", "int16", "int32", "int64", "leafref", "string", "uint8", "uint16", "uint32", "uint64", "union",
  ]);
  const featureCache = new Map<string, boolean>();
  const featureExists = (module: YangModule, name: string) => [module, ...submodulesFor(module)].some(source =>
    childrenOf(source, "feature").some(feature => feature.argument === name),
  );
  const evaluateFeature = (moduleName: string, expression: string, source: YangStatement): boolean => {
    const cacheKey = `${moduleName}:${expression}`;
    if (featureCache.has(cacheKey)) return featureCache.get(cacheKey)!;
    const context = modules.find(module => module.argument === moduleName);
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
      const resolved = resolveQName(context, token, modules);
      if (!resolved || !featureExists(resolved.module, resolved.name)) {
        report("unresolved-feature", `Feature '${token}' could not be resolved`, context, source);
        return false;
      }
      return Boolean(options.enabledFeatures?.has(`${resolved.module.argument}:${resolved.name}`));
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
  const resolveType = (owner: YangModule, type: YangStatement, stack: readonly string[] = []): { name?: string; chain: YangStatement[] } => {
    const typeName = type.argument ?? "";
    if (builtinTypes.has(typeName)) return { name: typeName, chain: [] };
    const resolved = resolveQName(owner, typeName, modules);
    if (!resolved) return { chain: [] };
    const key = `${moduleId(resolved.module)}:${resolved.name}`;
    if (stack.includes(key)) {
      report("typedef-cycle", `Typedef cycle: ${[...stack, key].join(" -> ")}`, owner, type);
      return { chain: [] };
    }
    const typedef = findTypedef(resolved.module, resolved.name);
    const baseType = typedef && childOf(typedef, "type");
    if (!typedef || !baseType) return { chain: [] };
    const base = resolveType(resolved.module, baseType, [...stack, key]);
    return { ...(base.name ? { name: base.name } : {}), chain: [typedef, ...base.chain] };
  };
  const findGrouping = (owner: YangModule, name: string): YangStatement | undefined => {
    const visit = (node: YangStatement): YangStatement | undefined => {
      for (const child of node.children) {
        if (child.keyword === "grouping" && child.argument === name) return child;
        const found = visit(child);
        if (found) return found;
      }
      return undefined;
    };
    return [owner, ...submodulesFor(owner)].map(visit).find(Boolean);
  };

  const makeNode = (
    statement: YangStatement, owner: YangModule, parentPath: string, inheritedConfig: boolean,
    groupingStack: readonly string[] = [], inheritedWhen: readonly YangStatement[] = [],
    inheritedFeatures: readonly { module: string; expression: string; source: YangStatement }[] = [],
    instantiatingModule: YangModule = owner,
  ): CompiledSchemaNode[] => {
    if (statement.keyword === "uses") {
      const resolved = resolveQName(owner, statement.argument ?? "", modules);
      if (!resolved) { report("unresolved-prefix", `Cannot resolve uses '${statement.argument ?? ""}'`, owner, statement); return []; }
      const groupingId = `${moduleId(resolved.module)}:${resolved.name}`;
      if (groupingStack.includes(groupingId)) { report("uses-cycle", `Grouping uses cycle: ${[...groupingStack, groupingId].join(" -> ")}`, owner, statement); return []; }
      const grouping = findGrouping(resolved.module, resolved.name);
      if (!grouping) { report("unresolved-grouping", `Grouping '${statement.argument ?? ""}' was not found`, owner, statement); return []; }
      const features = [...inheritedFeatures, ...childrenOf(statement, "if-feature").map(item => ({ module: owner.argument, expression: item.argument ?? "", source: item }))];
      if (options.enabledFeatures && !featureRequirementsEnabled(features)) return [];
      const when = [...inheritedWhen, ...childrenOf(statement, "when")];
      const expanded = dataChildren(grouping).flatMap(child => makeNode(child, resolved.module, parentPath, inheritedConfig, [...groupingStack, groupingId], when, features, instantiatingModule));
      const refineAllowed: Record<string, ReadonlySet<string>> = {
        leaf: new Set(["default", "description", "reference", "config", "must", "if-feature"]),
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
        if (!target) { report("unresolved-refine", `Refine target '${refine.argument ?? ""}' was not found in grouping '${resolved.name}'`, owner, refine); continue; }
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
    const nodeWhen = [...inheritedWhen, ...childrenOf(statement, "when")];
    const nodeFeatures = nodeFeatureRequirements.map(requirement => requirement.expression);
    const typeStatement = childOf(statement, "type");
    const resolvedType = typeStatement ? resolveType(owner, typeStatement) : undefined;
    if (typeStatement && !resolvedType?.name) report("unresolved-type", `Type '${typeStatement.argument ?? ""}' could not be resolved`, owner, typeStatement);
    const node: CompiledSchemaNode = {
      kind, name, module: instantiatingModule.argument, namespace: childOf(instantiatingModule, "namespace")?.argument ?? "",
      path, config, keys,
      ...(typeStatement ? { type: typeStatement } : {}),
      ...(resolvedType?.name ? { resolvedType: resolvedType.name } : {}),
      typedefChain: resolvedType?.chain ?? [],
      must: childrenOf(statement, "must"),
      whenConstraints: nodeWhen,
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
    if (kind === "list") {
      const directLeafNames = new Set(statement.children.filter(child => child.keyword === "leaf").map(child => child.argument));
      for (const key of keys) if (!directLeafNames.has(key)) report("invalid-key", `List key '${key}' is not a direct leaf of '${path}'`, owner, statement);
    }
    node.children = dataChildren(statement).flatMap(child => makeNode(child, owner, path, config, groupingStack, nodeWhen, nodeFeatureRequirements));
    checkDuplicates(node.children, owner);
    return [node];
  };

  for (const module of modules) {
    const ownerStatements = [module, ...submodulesFor(module)];
    for (const owner of ownerStatements) {
      for (const statement of dataChildren(owner)) roots.push(...makeNode(statement, module, "", true));
    }
  }
  for (const module of modules) checkDuplicates(roots.filter(node => node.module === module.argument), module);

  const qnamePath = (module: YangModule, path: string): Array<{ module: YangModule; name: string }> | undefined => {
    const parts = path.split("/").filter(Boolean);
    const resolved = parts.map(part => resolveQName(module, part, modules));
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
  const augments = modules.flatMap(module => childrenOf(module, "augment").map(statement => ({ module, statement })));
  const pending = [...augments];
  let madeProgress = true;
  while (pending.length && madeProgress) {
    madeProgress = false;
    for (let index = pending.length - 1; index >= 0; index--) {
      const item = pending[index]!;
      const path = qnamePath(item.module, item.statement.argument ?? "");
      if (!path) { report("unresolved-prefix", `Cannot resolve augment path '${item.statement.argument ?? ""}'`, item.module, item.statement); pending.splice(index, 1); continue; }
      const target = findTarget(path);
      if (!target) continue;
      const augmentWhen = childrenOf(item.statement, "when");
      const augmentFeatures = childrenOf(item.statement, "if-feature").map(feature => ({ module: item.module.argument, expression: feature.argument ?? "", source: feature }));
      if (options.enabledFeatures && !featureRequirementsEnabled(augmentFeatures)) { pending.splice(index, 1); madeProgress = true; continue; }
      const additions = item.statement.children.flatMap(child => makeNode(child, item.module, target.path, target.config, [], augmentWhen, augmentFeatures, item.module));
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
    childrenOf(source, "deviation").map(statement => ({ module, statement })),
  ));
  for (const { module, statement } of deviationSources) {
    const path = qnamePath(module, statement.argument ?? "");
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
  for (const module of modules) for (const statement of module.children) {
    if (statement.keyword !== "rpc" && statement.keyword !== "action" && statement.keyword !== "notification") continue;
    const compileScope = (scope: YangStatement | undefined, name: "input" | "output") => scope
      ? dataChildren(scope).flatMap(child => makeNode(child, module, `/${statement.argument}/${name}`, true))
      : [];
    operations.push({
      kind: statement.keyword, name: statement.argument ?? "", module: module.argument, source: statement,
      input: compileScope(childOf(statement, "input"), "input"), output: compileScope(childOf(statement, "output"), "output"),
    });
  }
  return { roots, operations, diagnostics, modules };
}
