import { describe, expect, it } from "vitest";
import { compileYangModules, createRestconfModuleLoader, parseYang, resolveModuleSet, yangLibraryEntries } from "../src/index.js";

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
    const libraryCalls = calls.filter(call => call.url === "https://host/restconf/ietf-yang-library:modules-state");
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
