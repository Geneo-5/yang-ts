import { describe, expect, it } from "vitest";
import { parseYang, resolveModuleSet } from "../src/index.js";

const TEST = "urn:test";
const module = (name: string, imports: string[] = []) => `module ${name} {
  namespace "urn:test"; prefix t;
  ${imports.map(imported => `import ${imported} { prefix ${imported}; }`).join("\n  ")}
  leaf probe { type string; }
}`;
const moduleSet = (names: string[], imports: Record<string, string[]> = {}) => {
  const loader = {
    async loadModule(name: string) {
      return module(name, imports[name] ?? []);
    },
  };
  return resolveModuleSet([parseYang(module(names[0]!, imports[names[0]! ?? ""] ?? []))], loader);
};

describe("module-set resource budgets and cancellation", () => {
  it("refuses loads past maxModules and records one budget diagnostic", async () => {
    const schema = parseYang(module("alpha", ["beta", "delta"]));
    const result = await resolveModuleSet([schema], { async loadModule(name) { return module(name); } },
      { budget: { maxModules: 1 } });
    expect(result.diagnostics.map(item => item.code)).toEqual(["budget-exceeded"]);
    expect(result.diagnostics[0]!.message).toContain("Module budget 1");
    expect(result.modules.map(item => item.argument).sort()).toEqual(["alpha", "beta"]);
  });

  it("limits submodule loads and import depth", async () => {
    const body = `module gamma {
      namespace "urn:test"; prefix t;
      leaf probe { type string; }
    }`;
    const result = await resolveModuleSet([parseYang(module("gamma-root", ["gamma"]))],
      { async loadModule(name) { return name === "gamma" ? body : module(name); } });
    expect(result.diagnostics).toEqual([]);

    const deepChain = async () => resolveModuleSet(
      [parseYang(module("one", ["two"]))],
      { async loadModule(name: string) {
          const chain: Record<string, string[]> = { two: ["three"], three: ["four"], four: [] };
          return module(name, chain[name] ?? []);
        } },
      { budget: { maxModules: 2 } },
    );
    const deep = await deepChain();
    expect(deep.diagnostics.map(item => item.code)).toEqual(["budget-exceeded"]);
    expect(deep.modules.map(item => item.argument).sort()).toEqual(["one", "three", "two"]);
  });

  it("counts source characters handed over by the loader", async () => {
    const schema = parseYang(module("counted", ["counted-dep"]));
    const result = await resolveModuleSet([schema],
      { async loadModule(name) { return module(name); } },
      { budget: { maxSourceCharacters: 10 } });
    expect(result.diagnostics.map(item => item.code)).toEqual(["budget-exceeded"]);
    expect(result.diagnostics[0]!.message).toContain("characters");
  });

  it("honors a wall-clock deadline", async () => {
    const result = await resolveModuleSet([parseYang(module("slow", ["slow-dep"]))],
      { async loadModule(name) { await new Promise(resolve => setTimeout(resolve, 5)); return module(name); } },
      { budget: { deadlineMs: 0 } });
    expect(result.diagnostics.map(item => item.code)).toEqual(["budget-exceeded"]);
    expect(result.diagnostics[0]!.message).toContain("deadline");
  });

  it("stops cleanly on an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    let loads = 0;
    const result = await resolveModuleSet([parseYang(module("aborted", ["dep"]))], {
      async loadModule(name) { loads++; return module(name); },
    }, { signal: controller.signal });
    expect(result.diagnostics.map(item => item.code)).toEqual(["cancelled"]);
    expect(loads).toBe(0);
    expect(result.modules.map(item => item.argument)).toEqual(["aborted"]);
  });

  it("keeps unconstrained resolution working and reports no diagnostics", async () => {
    const result = await moduleSet(["plain", "plain-dep"], { plain: ["plain-dep"] });
    expect(result.diagnostics).toEqual([]);
    expect(result.modules.map(item => item.argument).sort()).toEqual(["plain", "plain-dep"]);
  });
});
