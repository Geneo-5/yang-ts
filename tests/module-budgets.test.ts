import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { compileYangModules, evaluateCandidates, parseYang, resolveModuleSet, validateDataTree } from "../src/index.js";
import { compileXsdPattern } from "../src/types/xsd-pattern.js";
import { parseXml } from "./dom.js";

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

describe("beyond-loading budgets and cancellation", () => {
  const compile = async (source: string, budget?: { maxSchemaNodes?: number }) => compileYangModules(
    await resolveModuleSet([parseYang(source)], { async loadModule() { return undefined; } }),
    budget ? { budget } : {},
  );

  const expansion = `module expand {
    namespace "urn:test"; prefix t;
    grouping leaf-pair { leaf a { type string; } leaf b { type string; } }
    grouping wrapper { uses leaf-pair; container side { leaf c { type string; } } }
    container top {
      uses wrapper;
      list grid { key slot; leaf slot { type int16; } }
    }
  }`;

  it("caps grouping/uses expansion with a schema-node budget", async () => {
    // The schema fans out to more nodes than the budget allows: one
    // diagnostic, and expansion stops rather than growing unbounded.
    const compiled = await compile(expansion, { maxSchemaNodes: 5 });
    expect(compiled.diagnostics.map(item => item.code)).toEqual(["budget-exceeded"]);
    expect(compiled.diagnostics[0]!.message).toMatch(/[Ss]chema node budget 5/);

    const allowed = await compile(expansion, { maxSchemaNodes: 50 });
    expect(allowed.diagnostics).toEqual([]);
    // Unconstrained compilation stays unconstrained.
    const free = await compile(expansion);
    expect(free.diagnostics).toEqual([]);
  });

  it("keeps pathological patterns pending instead of compiling them", () => {
    // Classic exponential-backtracking shapes: an unbounded quantifier over a
    // group whose first and last atoms are both unboundedly quantified.
    // Compile stays undefined (pending).
    expect(compileXsdPattern("(a+)+")).toBeUndefined();
    expect(compileXsdPattern("(a*b*)*")).toBeUndefined();
    // Oversized patterns and oversized quantifier bounds never reach the
    // regex engine.
    expect(compileXsdPattern(`[a-z]{0,2}[0-9]{1,${"0".repeat(400)}}`)).toBeUndefined();
    expect(compileXsdPattern("[a-z]{2000}")).toBeUndefined();
    expect(compileXsdPattern("a".repeat(300))).toBeUndefined();
    // Ordinary patterns still compile, including shapes a crude detector
    // would falsely flag.
    expect(compileXsdPattern("[a-z]+")).toBeInstanceOf(RegExp);
    expect(compileXsdPattern("(ab|cd)+")).toBeInstanceOf(RegExp);
    expect(compileXsdPattern("(ab+)+")).toBeInstanceOf(RegExp);
    expect(compileXsdPattern("[a-z]+(-[a-z]+)*")).toBeInstanceOf(RegExp);
  });

  it("validates and enumerates candidates cooperatively via AbortSignal", async () => {
    const schemaText = `module bakery {
      namespace "urn:pan"; prefix p;
      container oven {
        leaf mode { type enumeration { enum off; enum on; } must "../mode = 'on' or ../mode = 'off'"; }
      }
    }`;
    const compiled = await compile(schemaText);
    const doc = parseXml(`<oven xmlns="urn:pan"><mode>on</mode></oven>`);
    const controller = new AbortController();
    controller.abort();
    const result = validateDataTree(compiled, doc, { signal: controller.signal });
    expect(result.status).toBe("indeterminate");
    expect(result.issues.map(item => item.code)).toEqual(["cancelled"]);

    const candidates = evaluateCandidates(compiled, parseXml(
      `<oven xmlns="urn:pan"><mode>on</mode></oven>`), "/oven/mode", { signal: controller.signal });
    expect(candidates.candidates.length).toBeGreaterThan(0);
    expect(candidates.candidates.every(item => item.status === "indeterminate")).toBe(true);
  });
});

describe("schema-scoped caches", () => {
  it("keeps identical module expressions of different schemas apart", async () => {
    const shopWith = (namespace: string) => `module shop {
      namespace "${namespace}"; prefix s;
      container cart { leaf total { type int16; } must "total > 0"; }
    }`;
    const first = compileYangModules(await resolveModuleSet([parseYang(shopWith("urn:shop:first"))], { async loadModule() { return undefined; } }));
    expect(first.diagnostics).toEqual([]);
    // A valid document caches the compiled must under (module, expression).
    expect(validateDataTree(first, parseXml(
      `<cart xmlns="urn:shop:first"><total>5</total></cart>`)).status).toBe("valid");

    // A second schema reuses the module and expression names but binds a
    // different namespace: the cached first-schema path must not answer it.
    const second = compileYangModules(await resolveModuleSet([parseYang(shopWith("urn:shop:second"))], { async loadModule() { return undefined; } }));
    expect(second.diagnostics).toEqual([]);
    expect(validateDataTree(second, parseXml(
      `<cart xmlns="urn:shop:second"><total>5</total></cart>`)).status).toBe("valid");
  });

  it("answers repeated compiles of the same expression with the same result", async () => {
    const schema = compileYangModules(await resolveModuleSet([parseYang(`module shop {
      namespace "urn:shop"; prefix s;
      container cart { leaf total { type int16; } must "total > 0"; }
    }`)], { async loadModule() { return undefined; } }));
    expect(validateDataTree(schema, parseXml(
      `<cart xmlns="urn:shop"><total>-1</total></cart>`)).issues.map(item => item.code)).toEqual(["must-unmet"]);
    // Second pass hits the cache: same verdict, no drift.
    expect(validateDataTree(schema, parseXml(
      `<cart xmlns="urn:shop"><total>-1</total></cart>`)).issues.map(item => item.code)).toEqual(["must-unmet"]);
  });
});
