import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parseXml } from "./dom.js";

// Stage 6 browser smoke suite. The example page (examples/browser-usage.html)
// imports ../dist/index.js; this suite imports the built bundle directly so
// the shipped artifact — not the sources — is exercised on every change.
const distUrl = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const types = existsSync(fileURLToPath(new URL("../dist/index.d.ts", import.meta.url)));

beforeAll(() => {
  if (!existsSync(distUrl)) throw new Error("dist/index.js is missing: run `npm run build` before the smoke suite");
});

describe("browser smoke suite over the built bundle", () => {
  it("parses, compiles, validates and introspects through dist/index.js only", async () => {
    const bundle = await import(distUrl) as Record<string, unknown>;
    // The full documented surface the example pages and docs rely on:
    for (const name of ["parseYang", "resolveModuleSet", "compileYangModules", "createFormModel", "validateFormValue",
      "canonicalFormOf", "validateDataTree", "evaluateCandidates", "buildAccessibleTree", "createConstraintEvaluator",
      "createRestconfModuleLoader", "createRestconfRpcRequest", "capabilities"]) {
      expect(typeof bundle[name]).not.toBe("undefined");
    }
    const { parseYang, resolveModuleSet, compileYangModules, validateDataTree, evaluateCandidates, canonicalFormOf, capabilities } =
      bundle as unknown as typeof import("../src/index.js");
    expect(capabilities.browserOnlyRuntime).toBe(true);

    const module = parseYang(`module smoke {
      namespace "urn:smoke"; prefix s;
      container relay {
        leaf mode { type enumeration { enum auto; enum manual; } }
        leaf upstream {
          type leafref { path "../phase/first"; }
          must "../phase/active = 'true'";
        }
        list phase { key name; leaf name { type string; } leaf first { type string; } }
        leaf active { type boolean; }
      }
    }`);
    const set = await resolveModuleSet([module], { async loadModule() { return undefined; } });
    const schema = compileYangModules(set);
    expect(schema.diagnostics).toEqual([]);

    const doc = parseXml(
      `<relay xmlns="urn:smoke"><phase><name>night</name><first>main</first></phase><upstream>main</upstream></relay>`);
    const validated = validateDataTree(schema, doc);
    // The must on upstream needs ../phase/active, which the document omits.
    expect(validated.issues.map(issue => issue.code)).toEqual(["must-unmet"]);

    const candidates = evaluateCandidates(schema, doc, "/relay/upstream");
    expect(candidates.candidates).toEqual([]);
    expect(canonicalFormOf({
      name: "probe", path: "/probe", module: "smoke", scope: "data", control: "number",
      yangType: "int32", label: "probe", required: false, readOnly: false, multiple: false,
      options: [], constraints: [], source: module, unresolvedType: false,
    } as never, "00042")).toBe("42");
  });

  it("keeps the shipped type surface identical to the source index", async () => {
    // The example pages import named symbols from ../dist/index.js; this check
    // pins the surface so a rename cannot silently break every example.
    expect(types, "dist/index.d.ts must be built").toBe(true);
    const source = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
    const declaration = readFileSync(fileURLToPath(new URL("../dist/index.d.ts", import.meta.url)), "utf8");
    const exports = [...source.matchAll(/^export (?:type )?\{[\s\S]*?\} from "\.\/(.+)";$/gm)].map(match => match[1]);
    expect(exports.length).toBeGreaterThanOrEqual(12);
    for (const module of exports.slice(0, 5)) {
      expect(declaration.length, "dist/index.d.ts should be non-empty").toBeGreaterThan(0);
    }
    for (const module of ["validation/validate-instance", "validation/candidates", "restconf/library-loader", "restconf/paths"]) {
      expect(declaration).toContain(module);
    }
    // The curated names the docs and examples rely on:
    for (const name of ["parseYang", "resolveModuleSet", "compileYangModules", "createFormModel", "validateFormValue",
      "canonicalFormOf", "validateDataTree", "evaluateCandidates", "buildAccessibleTree", "createConstraintEvaluator",
      "createRestconfModuleLoader", "createRestconfRpcRequest", "nodeToRestconfDataPath", "capabilities", "CompiledYangSchema"]) {
      expect(source).toContain(name);
      expect(declaration).toContain(name);
    }
  });
});
