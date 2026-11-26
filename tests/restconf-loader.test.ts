import { describe, expect, it } from "vitest";
import { compileYangModules, createRestconfModuleLoader, parseYang, resolveModuleSet } from "../src/index.js";
import { yangLibraryEntries } from "../src/internal.js";

const OVEN = `module oven {
  namespace "urn:oven"; prefix o;
  container oven { leaf temperature { type uint8; } }
}`;
const BREAD = `module bread {
  namespace "urn:bread"; prefix b;
  import oven { prefix o; }
  leaf crust { type string; }
}`;

interface Call { url: string; accept?: string }

function fakeFetch(library: unknown, schemaSources: Record<string, string | undefined>, calls: Call[]) {
  const impl = async (url: string | URL, init?: { headers?: Record<string, string> }): Promise<Response> => {
    const urlText = String(url);
    calls.push({ url: urlText, ...(init?.headers ? { accept: init.headers["accept"] } : {}) });
    if (urlText.includes("modules-state") || urlText.includes("yang-library")) {
      return { ok: true, status: 200, json: async () => library } as unknown as Response;
    }
    for (const [fragment, source] of Object.entries(schemaSources)) {
      if (urlText.includes(fragment)) {
        if (source === undefined) return { ok: false, status: 404 } as unknown as Response;
        return { ok: true, status: 200, text: async () => source } as unknown as Response;
      }
    }
    return { ok: false, status: 404 } as unknown as Response;
  };
  return impl as unknown as typeof fetch;
}

describe("RESTCONF YANG Library adapter", () => {
  it("reads module rows from both RFC 7895 and RFC 8525 payload shapes", () => {
    const rfc7895 = yangLibraryEntries({
      "ietf-yang-library:modules-state": {
        module: [
          { name: "oven", revision: "2020-01-01", namespace: "urn:oven", "conformance-type": "implement" },
        ],
      },
    });
    expect(rfc7895).toEqual([{ name: "oven", revision: "2020-01-01", namespace: "urn:oven", conformance: "implement" }]);
    const rfc8525 = yangLibraryEntries({
      "ietf-yang-library:yang-library": {
        "module-set": [
          { name: "main", module: [{ name: "bread", revision: "2023-05-01", location: "https://host/schemas/bread.yang" }] },
        ],
      },
    });
    expect(rfc8525).toEqual([{ name: "bread", revision: "2023-05-01", location: "https://host/schemas/bread.yang" }]);
    expect(() => yangLibraryEntries({ unexpected: true })).toThrow("no module list");
    expect(() => yangLibraryEntries("text")).toThrow("not a JSON object");
  });

  it("resolves an import closure from a live RESTCONF endpoint", async () => {
    const calls: Call[] = [];
    const library = {
      "ietf-yang-library:modules-state": {
        module: [
          { name: "bread", revision: "2023-05-01", namespace: "urn:bread", "conformance-type": "implement", location: "https://host/schemas/bread@2023-05-01.yang" },
          { name: "oven", revision: "2020-01-01", namespace: "urn:oven", "conformance-type": "implement", location: "https://host/schemas/oven@2020-01-01.yang" },
        ],
      },
    };
    const loader = createRestconfModuleLoader({
      baseUrl: "https://host/restconf",
      fetchImpl: fakeFetch(library, {
        "schemas/bread": BREAD,
        "schemas/oven": OVEN,
      }, calls),
    });
    const set = await resolveModuleSet([parseYang(BREAD)], loader);
    expect(set.diagnostics).toEqual([]);
    expect(set.modules.map(item => item.argument).sort()).toEqual(["bread", "oven"]);
    const libraryCalls = calls.filter(call => call.url === "https://host/restconf/data/ietf-yang-library:modules-state");
    expect(libraryCalls).toHaveLength(1);
    expect(calls.some(call => call.url === "https://host/schemas/oven@2020-01-01.yang")).toBe(true);
  });

  it("falls back to a schema URL template and reports missing modules", async () => {
    const calls: Call[] = [];
    const loader = createRestconfModuleLoader({
      baseUrl: "https://host/restconf",
      fetchImpl: fakeFetch({ "yang-library": { "module-set": [{ name: "s", module: [{ name: "oven", revision: "2020-01-01" }] }] } }, {
        "yaml-template": undefined,
      }, calls),
      libraryResource: "ietf-yang-library:yang-library",
      schemaUrlTemplate: moduleSchema => `https://host/restconf/yaml-template?module=${moduleSchema.name}@${moduleSchema.revision ?? ""}`,
    });
    const set = await resolveModuleSet([parseYang(BREAD)], loader);
    expect(set.diagnostics.map(item => item.code)).toEqual(["invalid-document"]);
    expect(calls.some(call => call.url === "https://host/restconf/yaml-template?module=oven@2020-01-01")).toBe(true);
  });

  it("compiles schemas fetched through the adapter end to end", async () => {
    const library = {
      "ietf-yang-library:modules-state": {
        module: [
          { name: "oven", revision: "2020-01-01", "conformance-type": "implement", location: "https://host/s/oven.yang" },
          { name: "bread", "conformance-type": "implement", location: "https://host/s/bread.yang" },
        ],
      },
    };
    const loader = createRestconfModuleLoader({
      baseUrl: "https://host/restconf",
      fetchImpl: fakeFetch(library, { "/oven.yang": OVEN, "/bread.yang": BREAD }, []),
    });
    const set = await resolveModuleSet([parseYang(BREAD)], loader);
    const schema = compileYangModules(set);
    expect(schema.diagnostics).toEqual([]);
    expect(schema.roots.map(root => root.name)).toContain("crust");
  });
});

describe("RESTCONF loader hardening (RFC 8040/8525)", () => {
  it("prefixes the default library resource with /data/", async () => {
    const calls: Call[] = [];
    const library = {
      "ietf-yang-library:modules-state": {
        module: [{ name: "oven", revision: "2020-01-01", "conformance-type": "implement", location: "https://host/s/oven.yang" }],
      },
    };
    const loader = createRestconfModuleLoader({
      baseUrl: "https://host/restconf",
      fetchImpl: fakeFetch(library, { "/oven.yang": OVEN }, calls),
    });
    const set = await resolveModuleSet([parseYang(BREAD)], loader);
    expect(set.diagnostics).toEqual([]);
    expect(calls.some(call => call.url === "https://host/restconf/data/ietf-yang-library:modules-state")).toBe(true);
    // The pre-RFC 8040 URL must no longer be requested.
    expect(calls.some(call => call.url === "https://host/restconf/ietf-yang-library:modules-state")).toBe(false);
  });

  it("loads submodules from the RFC 8525 nested submodule lists", async () => {
    const calls: Call[] = [];
    const breadParts = `submodule bread-parts { belongs-to bread { prefix b; } leaf crumb { type string; } }`;
    const breadModule = `module bread {
      namespace "urn:bread"; prefix b;
      include bread-parts;
      leaf crust { type string; }
    }`;
    const library = {
      "ietf-yang-library:yang-library": {
        "module-set": [{
          name: "main",
          module: [{ name: "bread", revision: "2024-01-01", namespace: "urn:bread", "conformance-type": "implement", location: "https://host/s/bread.yang" }],
          submodule: [{ name: "bread-parts", revision: "2024-01-01", location: "https://host/s/bread-parts.yang" }],
        }],
      },
    };
    const loader = createRestconfModuleLoader({
      baseUrl: "https://host/restconf",
      fetchImpl: fakeFetch(library, { "bread.yang": breadModule, "bread-parts.yang": breadParts }, calls),
    });
    const set = await resolveModuleSet([parseYang(breadModule)], loader);
    expect(set.diagnostics).toEqual([]);
    expect(calls.some(call => call.url === "https://host/s/bread-parts.yang")).toBe(true);
  });

  it("falls back to the RFC 7895 schema URL when a module row has no location", async () => {
    const calls: Call[] = [];
    const library = {
      "ietf-yang-library:modules-state": {
        module: [{ name: "oven", revision: "2020-01-01", "conformance-type": "implement", schema: "https://host/schema/oven.yang" }],
      },
    };
    const loader = createRestconfModuleLoader({
      baseUrl: "https://host/restconf",
      fetchImpl: fakeFetch(library, { "schema/oven.yang": OVEN }, calls),
    });
    const set = await resolveModuleSet([parseYang(BREAD)], loader);
    expect(set.diagnostics).toEqual([]);
    expect(calls.some(call => call.url === "https://host/schema/oven.yang")).toBe(true);
    expect(calls.some(call => call.url.includes("yang?module=oven"))).toBe(false);
  });

  it("passes an AbortSignal to schema and library requests", async () => {
    const calls: Call[] = [];
    const signals: unknown[] = [];
    const library = {
      "ietf-yang-library:modules-state": {
        module: [{ name: "oven", revision: "2020-01-01", "conformance-type": "implement", location: "https://host/s/oven.yang" }],
      },
    };
    const fetchImpl = async (url: string | URL, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<Response> => {
      calls.push({ url: String(url) });
      signals.push(init?.signal);
      if (String(url).includes("modules-state")) return { ok: true, status: 200, json: async () => library } as unknown as Response;
      return { ok: true, status: 200, text: async () => OVEN } as unknown as Response;
    };
    const controller = new AbortController();
    const loader = createRestconfModuleLoader({
      baseUrl: "https://host/restconf",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: controller.signal,
    });
    const set = await resolveModuleSet([parseYang(BREAD)], loader);
    expect(set.diagnostics).toEqual([]);
    expect(signals.filter(signal => signal === controller.signal).length).toBe(2);
  });
});
