import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileYangModules, parseYang, resolveModuleSet } from "../src/index.js";
import type { YangDocument } from "../src/index.js";

function fixture(path: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/yang/${path}`, import.meta.url)), "utf8");
}

describe("YANG module dependency resolution", () => {
  it("resolves the complete RFC 8343 interface import closure with pinned revisions", async () => {
    const source = fixture("standard/ietf/RFC/ietf-interfaces@2018-02-20.yang");
    const modules: Record<string, string> = {
      "ietf-yang-types": fixture("standard/ietf/RFC/ietf-yang-types@2013-07-15.yang"),
    };
    const result = await resolveModuleSet([parseYang(source)], {
      async loadModule(name, revision) {
        const candidate = modules[name];
        if (!candidate) return undefined;
        const module = parseYang(candidate);
        return !revision || module.children.some(child => child.keyword === "revision" && child.argument === revision) ? candidate : undefined;
      },
    });
    expect(result.modules.map(module => module.argument)).toEqual(["ietf-interfaces", "ietf-yang-types"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("resolves the full checked-in oven and interface augment fixture sets", async () => {
    const paths = [
      "sysrepo/oven.yang",
      "standard/ietf/RFC/ietf-interfaces@2018-02-20.yang",
      "standard/ietf/RFC/ietf-ip@2018-02-22.yang",
      "standard/ietf/RFC/ietf-inet-types@2013-07-15.yang",
      "standard/ietf/RFC/ietf-yang-types@2013-07-15.yang",
      "standard/ietf/draft/ietf-if-extensions@2025-08-07.yang",
      "standard/ietf/draft/ietf-if-ethernet-like@2025-08-07.yang",
      "standard/iana/iana-if-type@2023-01-26.yang",
    ];
    const sources = paths.map(fixture);
    const roots = sources.map(parseYang);
    const byName = new Map(roots.map(module => [module.argument, module]));
    const result = await resolveModuleSet(roots, { async loadModule(name) { return byName.get(name); } });
    expect(result.modules.map(module => module.argument)).toEqual([
      "iana-if-type", "ietf-if-ethernet-like", "ietf-if-extensions", "ietf-inet-types",
      "ietf-interfaces", "ietf-ip", "ietf-yang-types", "oven",
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("selects the newest unpinned revision and diagnoses duplicate source revisions", async () => {
    const root = parseYang(`module root { namespace "urn:root"; prefix r; import dep { prefix d; } }`);
    const dep = (revision: string) => `module dep { namespace "urn:dep"; prefix d; revision ${revision}; }`;
    const chosen = await resolveModuleSet([root], { async loadModule() { return [dep("2024-01-01"), dep("2025-01-01")]; } });
    expect(chosen.modules.find(module => module.argument === "dep")?.children.find(child => child.keyword === "revision")?.argument).toBe("2025-01-01");
    const ambiguous = await resolveModuleSet([root], { async loadModule() { return [dep("2025-01-01"), dep("2025-01-01")]; } });
    expect(ambiguous.diagnostics.map(item => item.code)).toContain("ambiguous-revision");
  });

  it("reports missing dependencies, import cycles and include cycles with source locations", async () => {
    const missingRoot = parseYang(`module root { namespace "urn:root"; prefix r; import absent { prefix a; } }`);
    const missing = await resolveModuleSet([missingRoot], { async loadModule(): Promise<YangDocument | undefined> { return undefined; } });
    expect(missing.diagnostics[0]).toMatchObject({ code: "missing-module", sourceModule: "root", sourceLocation: { line: 1 } });

    const a = parseYang(`module a { namespace "urn:a"; prefix a; import b { prefix b; } }`);
    const importCycle = await resolveModuleSet([a], {
      async loadModule(name) {
        if (name === "b") return `module b { namespace "urn:b"; prefix b; import a { prefix a; } }`;
        return undefined;
      },
    });
    expect(importCycle.diagnostics.map(item => item.code)).toContain("import-cycle");

    const includeRoot = parseYang(`module owner { namespace "urn:owner"; prefix o; include one; }`);
    const includeCycle = await resolveModuleSet([includeRoot], {
      async loadModule() { return undefined; },
      async loadSubmodule(name) {
        return name === "one"
          ? `submodule one { belongs-to owner { prefix o; } include two; }`
          : `submodule two { belongs-to owner { prefix o; } include one; }`;
      },
    });
    expect(includeCycle.diagnostics.map(item => item.code)).toContain("include-cycle");
  });

  it("resolves submodules and their imports and checks belongs-to", async () => {
    const root = parseYang(`module owner { namespace "urn:owner"; prefix o; include parts; }`);
    const resolved = await resolveModuleSet([root], {
      async loadModule(name) { return name === "dep" ? `module dep { namespace "urn:dep"; prefix d; }` : undefined; },
      async loadSubmodule() { return `submodule parts { belongs-to owner { prefix o; } import dep { prefix d; } }`; },
    });
    expect(resolved.submodules.map(module => module.argument)).toEqual(["parts"]);
    expect(resolved.modules.map(module => module.argument)).toEqual(["dep", "owner"]);
    expect(resolved.diagnostics).toEqual([]);

    const invalid = await resolveModuleSet([root], {
      async loadModule() { return undefined; },
      async loadSubmodule() { return `submodule parts { belongs-to someone-else { prefix x; } }`; },
    });
    expect(invalid.diagnostics.map(item => item.code)).toContain("invalid-belongs-to");
  });

  it("diagnoses two revisions of one module reached through differently pinned imports and compiles one", async () => {
    const dep = (revision: string) => `module dep { namespace "urn:dep"; prefix d; revision ${revision}; container offered { leaf id { type string; } } }`;
    const b = `module b { namespace "urn:b"; prefix b;
      import dep { prefix d; revision-date 2025-01-01; }
      import a { prefix x; }
      container consumer { leaf uses-dep { type string; } }
    }`;
    const a = `module a { namespace "urn:a"; prefix a; import dep { prefix d; revision-date 2024-01-01; } }`;
    const resolved = await resolveModuleSet([parseYang(b)], {
      async loadModule(name, pinned) {
        if (name === "dep") return dep(pinned ?? "2025-01-01");
        if (name === "a") return a;
        return undefined;
      },
    });
    // RFC 7950 section 5.6.5: imported revisions may differ, but the resolver
    // reports the conflict instead of silently keeping both.
    expect(resolved.diagnostics.map(item => item.code)).toContain("duplicate-revision");
    expect(resolved.modules.map(module => `${module.argument}@${module.children.find(child => child.keyword === "revision")?.argument}`))
      .toEqual(expect.arrayContaining(["dep@2024-01-01", "dep@2025-01-01"]));
    // Compilation binds one revision per module name (the newest): dep's nodes
    // appear once and no misleading per-node duplicate-node is reported.
    const schema = compileYangModules(resolved);
    expect(schema.diagnostics).toEqual([]);
    expect(schema.roots.filter(node => node.module === "dep" && node.name === "offered")).toHaveLength(1);
  });
});
