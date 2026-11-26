import { YangDocument, YangModuleLoader } from "../yang/module-set.js";

/** One module row of an ietf-yang-library payload (RFC 7895 / RFC 8525). */
export interface YangLibraryModuleEntry {
  name: string;
  revision?: string;
  namespace?: string;
  /** RFC 7895 conformance-type; `import` modules still load for compilation. */
  conformance?: "implement" | "import";
  /** URL for fetching the module's YANG source, if the server advertises one. */
  location?: string | readonly string[];
  /** RFC 7895 `schema` leaf: URL for the XML-format schema resource. */
  schema?: string;
}

const jsonHeaders = { accept: "application/yang-data+json" };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function firstRecord(object: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const record = asRecord(object[key]);
    if (record) return record;
  }
  return undefined;
}

function normalizeEntry(row: unknown): YangLibraryModuleEntry | undefined {
  const object = asRecord(row);
  if (!object) return undefined;
  const name = typeof object["name"] === "string" ? object["name"] : undefined;
  if (!name) return undefined;
  const revision = typeof object["revision"] === "string" && object["revision"] ? object["revision"] : undefined;
  const namespace = typeof object["namespace"] === "string" ? object["namespace"] : undefined;
  const conformance = object["conformance-type"] === "import" ? "import" as const
    : object["conformance-type"] === "implement" ? "implement" as const : undefined;
  const rawLocation = object["location"];
  const location = rawLocation === undefined ? undefined
    : typeof rawLocation === "string" ? rawLocation
      : Array.isArray(rawLocation) ? rawLocation.filter((item): item is string => typeof item === "string") : undefined;
  const schema = typeof object["schema"] === "string" && object["schema"] ? object["schema"] : undefined;
  return {
    name, ...(revision ? { revision } : {}), ...(namespace ? { namespace } : {}),
    ...(conformance ? { conformance } : {}), ...(location ? { location } : {}), ...(schema ? { schema } : {}),
  };
}

function rowsToEntries(rows: unknown): YangLibraryModuleEntry[] {
  const list = Array.isArray(rows) ? rows : rows !== undefined ? [rows] : [];
  return list.map(normalizeEntry).filter((entry): entry is YangLibraryModuleEntry => entry !== undefined);
}

/** Modules and submodules of an ietf-yang-library payload (RFC 7895 / RFC 8525). */
export interface YangLibraryInventory {
  modules: YangLibraryModuleEntry[];
  /** RFC 8525 nested `submodule` lists; empty for RFC 7895 payloads. */
  submodules: YangLibraryModuleEntry[];
}

/**
 * Modules and submodules of an ietf-yang-library payload. Accepts the RFC 7895
 * `modules-state` shape and the RFC 8525 `yang-library`/`module-set` shape,
 * with or without the `ietf-yang-library` prefix, or an already-unwrapped
 * module list.
 *
 * RFC 7895 section 5.2 and RFC 8525 (2019-01-04) nest the `submodule` list
 * inside each `module` — and RFC 8525 also inside each `import-only-module`
 * — row, and RFC 8525 lists import-only modules under their own
 * `import-only-module` list; both are flattened into the inventory.
 */
export function yangLibraryInventory(payload: unknown): YangLibraryInventory {
  const object = asRecord(payload);
  if (!object) throw new Error("YANG Library payload is not a JSON object");
  const modulesState = firstRecord(object, ["ietf-yang-library:modules-state", "modules-state"]);
  if (modulesState) return inventoryOfModuleRows(modulesState["module"]);
  const yangLibrary = firstRecord(object, ["ietf-yang-library:yang-library", "yang-library"]);
  if (yangLibrary) {
    const sets = yangLibrary["module-set"];
    const setList = Array.isArray(sets) ? sets : sets !== undefined ? [sets] : [];
    return setList.reduce<YangLibraryInventory>((inventory, set) => {
      const record = asRecord(set);
      if (!record) return inventory;
      // RFC 8525: an import-only module can only be imported, so missing
      // conformance-type rows default to `import`.
      const importOnly = rowsToEntries(record["import-only-module"])
        .map(entry => entry.conformance ? entry : { ...entry, conformance: "import" as const });
      return {
        modules: [...inventory.modules, ...rowsToEntries(record["module"]), ...importOnly],
        submodules: [...inventory.submodules,
          ...submodulesOfRows(record["module"]),
          ...submodulesOfRows(record["import-only-module"]),
        ],
      };
    }, { modules: [], submodules: [] });
  }
  if (object["module"]) {
    const inventory = inventoryOfModuleRows(object["module"]);
    return { modules: inventory.modules, submodules: [...inventory.submodules, ...rowsToEntries(object["submodule"])] };
  }
  throw new Error("YANG Library payload has no module list (expected modules-state or yang-library module-set)");
}

/** Flatten the `submodule` lists nested in each module/import-only-module row. */
function submodulesOfRows(rows: unknown): YangLibraryModuleEntry[] {
  const list = Array.isArray(rows) ? rows : rows !== undefined ? [rows] : [];
  return list.flatMap(row => {
    const record = asRecord(row);
    return record ? rowsToEntries(record["submodule"]) : [];
  });
}

/** Module rows whose nested `submodule` lists become inventory submodules. */
function inventoryOfModuleRows(rows: unknown): YangLibraryInventory {
  return { modules: rowsToEntries(rows), submodules: submodulesOfRows(rows) };
}

/**
 * Module rows of an ietf-yang-library payload. Accepts the RFC 7895
 * `modules-state` shape and the RFC 8525 `yang-library`/`module-set` shape,
 * with or without the `ietf-yang-library` prefix, or an already-unwrapped
 * module list.
 */
export function yangLibraryEntries(payload: unknown): YangLibraryModuleEntry[] {
  return yangLibraryInventory(payload).modules;
}

export interface RestconfLoaderOptions {
  /** RESTCONF root, e.g. `https://host/restconf`. */
  baseUrl: string;
  /** Fetch implementation; defaults to globalThis.fetch when available. */
  fetchImpl?: typeof fetch;
  /**
   * Datastore resource path of the YANG Library payload; defaults to
   * `ietf-yang-library:modules-state`, requested under the RFC 8040 `/data/`
   * subtree. A pre-qualified path (`data/…`, `operations/…`) or an absolute
   * URL is used unchanged. Pass `ietf-yang-library:yang-library` for servers
   * exposing the RFC 8525 datastore only.
   */
  libraryResource?: string;
  /** Schema source template used when an entry carries no `location` URL. */
  schemaUrlTemplate?: (module: { name: string; revision?: string; namespace?: string }) => string;
  /** Supply the library payload directly, e.g. pre-fetched or embedded. */
  libraryPayload?: unknown;
  /** Abort signal forwarded to every schema/library request. */
  signal?: AbortSignal;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** RFC 8040 §3.1: RESTCONF data resources live under the `/data` subtree. */
function dataResource(resource: string): string {
  if (/^[\w+.-]+:\/\//.test(resource) || /^(data|operations)\/+/.test(resource)) return resource;
  return `data/${resource}`;
}

/**
 * A YangModuleLoader that discovers the module set from an ietf-yang-library
 * RESTCONF resource and fetches YANG schema sources from each entry's
 * `location` URL or a supplied template. It is a pure adapter: it hands
 * document text to `resolveModuleSet` and never touches the compiler core.
 */
export function createRestconfModuleLoader(options: RestconfLoaderOptions): YangModuleLoader {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) throw new Error("No fetch implementation available: pass fetchImpl in RestconfLoaderOptions");

  let entriesPromise: Promise<YangLibraryInventory> | undefined;
  const inventory = (): Promise<YangLibraryInventory> => {
    entriesPromise ??= (async () => {
      if (options.libraryPayload !== undefined) return yangLibraryInventory(options.libraryPayload);
      const resource = options.libraryResource ?? "ietf-yang-library:modules-state";
      const url = /^[\w+.-]+:\/\//.test(resource) ? resource : joinUrl(options.baseUrl, dataResource(resource));
      const response = await fetchImpl(url, { headers: jsonHeaders, ...(options.signal ? { signal: options.signal } : {}) });
      if (!response.ok) throw new Error(`YANG Library request failed: ${response.status} for ${url}`);
      return yangLibraryInventory(await response.json());
    })();
    return entriesPromise;
  };

  const sourceText = async (module: YangLibraryModuleEntry): Promise<YangDocument | undefined> => {
    const locations = module.location === undefined ? [] : Array.isArray(module.location) ? module.location : [module.location];
    const url = locations[0]
      ?? module.schema
      ?? options.schemaUrlTemplate?.({ name: module.name, ...(module.revision ? { revision: module.revision } : {}), ...(module.namespace ? { namespace: module.namespace } : {}) })
      ?? joinUrl(options.baseUrl, `yang?module=${encodeURIComponent(module.name)}${module.revision ? `&revision=${encodeURIComponent(module.revision)}` : ""}`);
    const response = await fetchImpl(url, { headers: { accept: "application/yang" }, ...(options.signal ? { signal: options.signal } : {}) });
    if (!response.ok) throw new Error(`Schema request failed: ${response.status} for ${url}`);
    return response.text();
  };

  const find = async (kind: "module" | "submodule", name: string, revision?: string): Promise<YangLibraryModuleEntry | undefined> => {
    // Submodules live in the RFC 8525 nested `submodule` lists; RFC 7895
    // payloads list none, so those rows fall back to the flat module rows.
    const pool = await inventory();
    const rows = kind === "module" ? pool.modules : [...pool.submodules, ...pool.modules];
    const candidates = rows.filter(entry => entry.name === name
      && (revision === undefined || entry.revision === revision || entry.revision === undefined));
    if (candidates.length === 0) return undefined;
    if (revision !== undefined) {
      const pinned = candidates.find(entry => entry.revision === revision);
      if (pinned) return pinned;
      if (candidates.length > 1) return undefined;
    }
    // Newest revision wins when the caller left the revision to the server.
    return candidates.sort((a, b) => (b.revision ?? "").localeCompare(a.revision ?? ""))[0];
  };

  return {
    async loadModule(name, revision) {
      const entry = await find("module", name, revision);
      return entry ? sourceText(entry) : undefined;
    },
    async loadSubmodule(name, revision) {
      const entry = await find("submodule", name, revision);
      return entry ? sourceText(entry) : undefined;
    },
  };
}
