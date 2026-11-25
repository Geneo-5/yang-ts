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
    "unexpected-document" | "missing-revision" | "include-cycle" | "import-cycle" | "invalid-belongs-to" |
    "cancelled" | "budget-exceeded";
  message: string;
  sourceModule: string;
  sourceLocation: YangStatement["location"];
}

/**
 * Resource budget for untrusted module sets (Stage 6 browser readiness):
 * once any limit is reached, further loads are refused and a single
 * `budget-exceeded`/`cancelled` diagnostic is recorded.
 */
export interface ModuleSetBudget {
  /**
   * Maximum number of modules fetched through the loader. Roots arrive
   * pre-parsed from the caller and do not count against this limit.
   */
  maxModules?: number;
  maxSubmodules?: number;
  /** Maximum import/include chain depth below the roots. */
  maxDepth?: number;
  /**
   * Total characters of text documents handed over by the loader. Payloads
   * supplied as parsed ASTs cannot be measured before parsing and are not counted.
   */
  maxSourceCharacters?: number;
  /** Wall-clock budget in milliseconds over the whole resolution. */
  deadlineMs?: number;
}

export interface ModuleSetConstraints {
  budget?: ModuleSetBudget;
  /** Host-owned cancellation (AbortController.signal in the browser). */
  signal?: AbortSignal;
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
export async function resolveModuleSet(roots: readonly YangModule[], loader: YangModuleLoader, constraints: ModuleSetConstraints = {}): Promise<YangModuleSet> {
  const budget = constraints.budget ?? {};
  const startedAt = Date.now();
  let sourceCharacters = 0;
  let violationReported = false;
  const diagnostics: ModuleSetDiagnostic[] = [];

  /** Decide whether another load may run: refuses all loads after the first violation. */
  const guard = (kind: "module" | "submodule", name: string, owner: YangModule, statement: YangStatement): boolean => {
    if (violationReported) return false;
    if (constraints.signal?.aborted) {
      violationReported = true;
      diagnostics.push({ code: "cancelled", message: `Resolution was cancelled while loading ${kind} '${name}'`, sourceModule: owner.argument, sourceLocation: statement.location });
      return false;
    }
    const { deadlineMs } = budget;
    if (deadlineMs !== undefined && Date.now() - startedAt > deadlineMs) {
      violationReported = true;
      diagnostics.push({ code: "budget-exceeded", message: `Resolution exceeded the ${deadlineMs} ms deadline while loading ${kind} '${name}'`, sourceModule: owner.argument, sourceLocation: statement.location });
      return false;
    }
    if (kind === "module" && budget.maxModules !== undefined && moduleLoads.size + submodules.size >= budget.maxModules) {
      violationReported = true;
      diagnostics.push({ code: "budget-exceeded", message: `Module budget ${budget.maxModules} reached while loading '${name}'`, sourceModule: owner.argument, sourceLocation: statement.location });
      return false;
    }
    if (kind === "submodule" && budget.maxSubmodules !== undefined && submodules.size >= budget.maxSubmodules) {
      violationReported = true;
      diagnostics.push({ code: "budget-exceeded", message: `Submodule budget ${budget.maxSubmodules} reached while loading '${name}'`, sourceModule: owner.argument, sourceLocation: statement.location });
      return false;
    }
    return true;
  };
  const trackSource = (document: YangDocument | readonly YangDocument[] | undefined): void => {
    for (const item of (document === undefined ? [] : Array.isArray(document) ? document : [document])) {
      if (typeof item === "string") sourceCharacters += item.length;
    }
    const { maxSourceCharacters } = budget;
    if (maxSourceCharacters !== undefined && sourceCharacters > maxSourceCharacters && !violationReported) {
      violationReported = true;
      diagnostics.push({
        code: "budget-exceeded",
        message: `Source budget ${maxSourceCharacters} characters exceeded (${sourceCharacters} loaded)`,
        sourceModule: (roots[0] ?? { argument: "" }).argument,
        sourceLocation: roots[0]?.location ?? { offset: 0, line: 1, column: 1 },
      });
    }
  };

  const modules = new Map<string, YangModule>();
  const submodules = new Map<string, YangModule>();
  const moduleLoads = new Map<string, Promise<YangModule | undefined>>();
  const submoduleLoads = new Map<string, Promise<YangModule | undefined>>();

  const moduleKey = (module: YangModule) => `${module.argument}@${revisionOf(module) ?? ""}`;
  const report = (code: ModuleSetDiagnostic["code"], message: string, owner: YangModule, statement: YangStatement) =>
    diagnostics.push({ code, message, sourceModule: owner.argument, sourceLocation: statement.location });

  /** One budget-exceeded violation switches the resolver into refusing mode. */
  const reportBudget = (message: string, owner: YangModule, statement: YangStatement): void => {
    if (violationReported) return;
    violationReported = true;
    report("budget-exceeded", message, owner, statement);
  };
  const depthExceeded = (depth: number): boolean =>
    budget.maxDepth !== undefined && depth > budget.maxDepth;

  const loadModule = (name: string, pinned: string | undefined, owner: YangModule, statement: YangStatement): Promise<YangModule | undefined> => {
    const queryKey = `${name}@${pinned ?? "*"}`;
    const existing = moduleLoads.get(queryKey);
    if (existing) return existing;
    const task = (async () => {
      if (!guard("module", name, owner, statement)) return undefined;
      let result: YangDocument | readonly YangDocument[] | undefined;
      try { result = await loader.loadModule(name, pinned); }
      catch (error) { report("invalid-document", `Failed loading module '${name}': ${String(error)}`, owner, statement); return undefined; }
      trackSource(result);
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
      if (!guard("submodule", name, owner, statement)) return undefined;
      if (!loader.loadSubmodule) { report("missing-submodule", `No submodule loader is configured for '${name}'`, owner, statement); return undefined; }
      let result: YangDocument | readonly YangDocument[] | undefined;
      try { result = await loader.loadSubmodule(name, pinned); }
      catch (error) { report("invalid-document", `Failed loading submodule '${name}': ${String(error)}`, owner, statement); return undefined; }
      trackSource(result);
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
      // Include depth: the direct includes of a root sit at depth 1
      // (RFC 7950 section 5.1.2 chains count below the root module).
      if (depthExceeded(stack.length + 1)) {
        reportBudget(`Submodule include chain depth ${stack.length + 1} exceeds maxDepth ${budget.maxDepth} while resolving '${name}'`, owner, include);
        continue;
      }
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
        // Import depth: a root's direct imports sit at depth 1.
        if (depthExceeded(stack.length + 1)) {
          reportBudget(`Import chain depth ${stack.length + 1} exceeds maxDepth ${budget.maxDepth} while resolving '${name}'`, module, imported);
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
  if (!violationReported && budget.deadlineMs !== undefined && Date.now() - startedAt > budget.deadlineMs) {
    violationReported = true;
    diagnostics.push({
      code: "budget-exceeded",
      message: `Resolution exceeded the ${budget.deadlineMs} ms deadline`,
      sourceModule: (roots[0] ?? { argument: "" }).argument,
      sourceLocation: roots[0]?.location ?? { offset: 0, line: 1, column: 1 },
    });
  }
  return {
    roots: [...roots].filter(module => module.keyword === "module"),
    modules: [...modules.values()].sort((a, b) => a.argument.localeCompare(b.argument) || (revisionOf(a) ?? "").localeCompare(revisionOf(b) ?? "")),
    submodules: [...submodules.values()].sort((a, b) => a.argument.localeCompare(b.argument) || (revisionOf(a) ?? "").localeCompare(revisionOf(b) ?? "")),
    diagnostics,
  };
}
