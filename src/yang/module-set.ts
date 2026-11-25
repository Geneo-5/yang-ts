import { YangModule, YangStatement } from "./ast.js";
import { childOf, childrenOf, parseYang } from "./parser.js";

export type YangDocument = YangModule | string;

/** The host controls where sources come from (bundled text, IndexedDB, fetch, etc.). */
export interface YangModuleLoader {
  loadModule(name: string, revision?: string): Promise<YangDocument | readonly YangDocument[] | undefined>;
  loadSubmodule?(name: string, revision?: string): Promise<YangDocument | readonly YangDocument[] | undefined>;
}

export interface ModuleSetDiagnostic {
  code: "missing-module" | "missing-submodule" | "ambiguous-revision" | "invalid-document" |
    "unexpected-document" | "missing-revision" | "include-cycle" | "import-cycle" | "invalid-belongs-to";
  message: string;
  sourceModule: string;
  sourceLocation: YangStatement["location"];
}

export interface YangModuleSet {
  roots: readonly YangModule[];
  modules: readonly YangModule[];
  submodules: readonly YangModule[];
  diagnostics: readonly ModuleSetDiagnostic[];
}

const revisionOf = (document: YangModule): string | undefined => childOf(document, "revision")?.argument;
const sourceStatements = (module: YangModule, submodules: readonly YangModule[]): YangStatement[] => [module, ...submodules];

function parseDocument(document: YangDocument): YangModule {
  return typeof document === "string" ? parseYang(document) : document;
}

function normalizedDocuments(result: YangDocument | readonly YangDocument[] | undefined): readonly YangDocument[] {
  if (result === undefined) return [];
  return Array.isArray(result) ? result : [result as YangDocument];
}

function selectDocument(
  candidates: readonly YangDocument[], expectedName: string, kind: "module" | "submodule", pinnedRevision: string | undefined,
  owner: YangModule, statement: YangStatement, diagnostics: ModuleSetDiagnostic[],
): YangModule | undefined {
  const parsed: YangModule[] = [];
  for (const candidate of candidates) {
    try { parsed.push(parseDocument(candidate)); }
    catch (error) {
      diagnostics.push({ code: "invalid-document", message: `Could not parse ${kind} '${expectedName}': ${String(error)}`, sourceModule: owner.argument, sourceLocation: statement.location });
    }
  }
  const matching = parsed.filter(item => item.keyword === kind && item.argument === expectedName);
  if (matching.length !== parsed.length) diagnostics.push({
    code: "unexpected-document", message: `Loader returned a document other than ${kind} '${expectedName}'`,
    sourceModule: owner.argument, sourceLocation: statement.location,
  });
  const eligible = matching.filter(item => !pinnedRevision || revisionOf(item) === pinnedRevision);
  if (pinnedRevision && eligible.length === 0) {
    diagnostics.push({ code: "missing-revision", message: `${kind} '${expectedName}' has no revision '${pinnedRevision}'`, sourceModule: owner.argument, sourceLocation: statement.location });
    return undefined;
  }
  if (eligible.length === 0) return undefined;
  const revisions = eligible.map(item => revisionOf(item) ?? "").sort().reverse();
  const latest = revisions[0]!;
  const sameRevision = eligible.filter(item => (revisionOf(item) ?? "") === latest);
  if (sameRevision.length > 1) {
    diagnostics.push({ code: "ambiguous-revision", message: `${kind} '${expectedName}' has multiple sources for revision '${latest || "(unrevisioned)"}'`, sourceModule: owner.argument, sourceLocation: statement.location });
    return undefined;
  }
  return sameRevision[0];
}

/** Resolve a transitive module and submodule closure without depending on browser transport APIs. */
export async function resolveModuleSet(roots: readonly YangModule[], loader: YangModuleLoader): Promise<YangModuleSet> {
  const modules = new Map<string, YangModule>();
  const submodules = new Map<string, YangModule>();
  const diagnostics: ModuleSetDiagnostic[] = [];
  const moduleLoads = new Map<string, Promise<YangModule | undefined>>();
  const submoduleLoads = new Map<string, Promise<YangModule | undefined>>();

  const moduleKey = (module: YangModule) => `${module.argument}@${revisionOf(module) ?? ""}`;
  const report = (code: ModuleSetDiagnostic["code"], message: string, owner: YangModule, statement: YangStatement) =>
    diagnostics.push({ code, message, sourceModule: owner.argument, sourceLocation: statement.location });

  const loadModule = (name: string, pinned: string | undefined, owner: YangModule, statement: YangStatement): Promise<YangModule | undefined> => {
    const queryKey = `${name}@${pinned ?? "*"}`;
    const existing = moduleLoads.get(queryKey);
    if (existing) return existing;
    const task = (async () => {
      let result: YangDocument | readonly YangDocument[] | undefined;
      try { result = await loader.loadModule(name, pinned); }
      catch (error) { report("invalid-document", `Failed loading module '${name}': ${String(error)}`, owner, statement); return undefined; }
      const selected = selectDocument(normalizedDocuments(result), name, "module", pinned, owner, statement, diagnostics);
      if (!selected) {
        if (result === undefined || normalizedDocuments(result).length === 0) report("missing-module", `Module '${name}' was not found`, owner, statement);
        return undefined;
      }
      return selected;
    })();
    moduleLoads.set(queryKey, task);
    return task;
  };

  const loadSubmodule = (name: string, pinned: string | undefined, owner: YangModule, statement: YangStatement): Promise<YangModule | undefined> => {
    const queryKey = `${name}@${pinned ?? "*"}`;
    const existing = submoduleLoads.get(queryKey);
    if (existing) return existing;
    const task = (async () => {
      if (!loader.loadSubmodule) { report("missing-submodule", `No submodule loader is configured for '${name}'`, owner, statement); return undefined; }
      let result: YangDocument | readonly YangDocument[] | undefined;
      try { result = await loader.loadSubmodule(name, pinned); }
      catch (error) { report("invalid-document", `Failed loading submodule '${name}': ${String(error)}`, owner, statement); return undefined; }
      const selected = selectDocument(normalizedDocuments(result), name, "submodule", pinned, owner, statement, diagnostics);
      if (!selected && (result === undefined || normalizedDocuments(result).length === 0)) report("missing-submodule", `Submodule '${name}' was not found`, owner, statement);
      if (selected && childOf(selected, "belongs-to")?.argument !== owner.argument) {
        report("invalid-belongs-to", `Submodule '${name}' does not belong to module '${owner.argument}'`, owner, statement);
        return undefined;
      }
      return selected;
    })();
    submoduleLoads.set(queryKey, task);
    return task;
  };

  const expandSubmodules = async (owner: YangModule, current: YangModule, stack: readonly string[]): Promise<YangModule[]> => {
    const included: YangModule[] = [];
    for (const include of childrenOf(current, "include")) {
      const name = include.argument ?? "";
      if (stack.includes(name)) { report("include-cycle", `Submodule include cycle: ${[...stack, name].join(" -> ")}`, owner, include); continue; }
      const revision = childOf(include, "revision-date")?.argument;
      const submodule = await loadSubmodule(name, revision, owner, include);
      if (!submodule) continue;
      const key = `${submodule.argument}@${revisionOf(submodule) ?? ""}`;
      if (!submodules.has(key)) submodules.set(key, submodule);
      included.push(submodule, ...await expandSubmodules(owner, submodule, [...stack, name]));
    }
    return included;
  };

  const processed = new Set<string>();
  const processModule = async (module: YangModule, stack: readonly string[]): Promise<void> => {
    const key = moduleKey(module);
    modules.set(key, module);
    if (processed.has(key)) return;
    processed.add(key);
    const included = await expandSubmodules(module, module, []);
    for (const source of sourceStatements(module, included)) {
      for (const imported of childrenOf(source, "import")) {
        const name = imported.argument ?? "";
        const revision = childOf(imported, "revision-date")?.argument;
        if (name === module.argument || stack.some(active => active.startsWith(`${name}@`))) {
          report("import-cycle", `Module import cycle: ${[...stack, key, `${name}@${revision ?? ""}`].join(" -> ")}`, module, imported);
          continue;
        }
        const dependency = await loadModule(name, revision, module, imported);
        if (!dependency) continue;
        const dependencyKey = moduleKey(dependency);
        if (stack.includes(dependencyKey)) {
          report("import-cycle", `Module import cycle: ${[...stack, dependencyKey].join(" -> ")}`, module, imported);
          continue;
        }
        await processModule(dependency, [...stack, key]);
      }
    }
  };

  for (const root of roots) {
    if (root.keyword !== "module") {
      diagnostics.push({ code: "unexpected-document", message: `Entry root '${root.argument}' is a submodule, not a module`, sourceModule: root.argument, sourceLocation: root.location });
      continue;
    }
    await processModule(root, []);
  }
  return {
    roots: [...roots].filter(module => module.keyword === "module"),
    modules: [...modules.values()].sort((a, b) => a.argument.localeCompare(b.argument) || (revisionOf(a) ?? "").localeCompare(revisionOf(b) ?? "")),
    submodules: [...submodules.values()].sort((a, b) => a.argument.localeCompare(b.argument) || (revisionOf(a) ?? "").localeCompare(revisionOf(b) ?? "")),
    diagnostics,
  };
}
