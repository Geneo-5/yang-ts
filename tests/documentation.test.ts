import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.js";
import * as reactApi from "../src/react/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const GUIDE = `${root}/GUIDE.md`;

/** The engine APIs the guide must document (the complete public surface). */
const DOCUMENTED_APIS = [
  "parseYang", "YangSyntaxError", "resolveModuleSet", "compileYangModules",
  "serializeCompiledSchema", "deserializeCompiledSchema", "CompiledSchemaFormatError",
  "buildAccessibleTree", "createConstraintEvaluator", "validateDataTree", "evaluateCandidates",
  "createFormModel", "validateFormValue", "canonicalFormOf",
  "activeCaseFields", "activeRequiredValues", "listEntryFields", "listEntryValues", "withListEntry",
  "yangJsonToDocument", "documentToYangJson", "YangJsonError",
  "createRestconfModuleLoader", "findSchemaLibraryMismatches", "yangLibraryInventory",
  "nodeToRestconfDataPath", "nodeToRestconfDatastorePath", "nodeToXPath",
  "createRestconfGetRequest", "createRestconfDatastoreRequest", "createRestconfNmdaProbeRequest",
  "createRestconfSetRequest", "createRestconfAddRequest", "createRestconfUpdateRequest",
  "createRestconfDeleteRequest", "createRestconfRpcRequest",
  "readRestconfData", "readRestconfRpcOutput",
];

/** Calls the guide makes that are not engine APIs (globals and JS built-ins). */
const NON_ENGINE_CALLS = new Set([
  "DOMParser", "XMLSerializer", "JSON", "Math", "Number", "String", "Boolean",
  "fetch", "console", "Error", "Promise", "URL", "Set", "Map", "Response",
  "FormData", "RegExp", "Date", "encodeURIComponent", "decodeURIComponent",
  "AbortController", "Interaction", "await", "new", "return", "if", "for", "while", "throw", "typeof", "import", "export",
  "try", "catch", "finally", "else", "switch", "case", "function", "async", "then",
  // chargers and helpers the guide defines itself in its snippets
  "loadModule", "loadSubmodule", "send",
  // React — a peer dependency's API, not the engine's (§208)
  "createElement", "useEffect", "useState", "useMemo", "useRef", "useCallback",
]);

const extractCodeBlocks = (markdown: string): string[] =>
  [...markdown.matchAll(/```(?:ts|typescript|sh|bash|shell)\n([\s\S]*?)```/g)].map(match => match[1]!);

describe("usage guide", () => {
  const markdown = existsSync(GUIDE) ? readFileSync(GUIDE, "utf8") : undefined;

  it("exists and covers the pipeline end to end", () => {
    expect(markdown, "GUIDE.md is the usage guide — see ROADMAP Stage 8b").toBeDefined();
  });

  it("documents every public engine API", () => {
    expect(markdown).toBeDefined();
    if (!markdown) return;
    for (const api of DOCUMENTED_APIS) {
      expect(new RegExp(`\\b${api}\\b`).test(markdown), `GUIDE.md must mention '${api}'`).toBe(true);
      expect(api in publicApi, `'${api}' must exist in the public barrel`).toBe(true);
    }
  });

  it("documents the React hooks of yang-browser-engine/react (§208)", () => {
    expect(markdown).toBeDefined();
    if (!markdown) return;
    for (const hook of ["YangProvider", "useYangSchema", "useFormModel", "useFieldValidation", "useDataValidation", "useCandidates", "useRestconfResource"]) {
      expect(new RegExp(`\\b${hook}\\b`).test(markdown), `GUIDE.md must mention '${hook}'`).toBe(true);
      // The sub-path barrel decides existence; the core barrel stays React-free.
      expect(hook in reactApi, `'${hook}' must exist in yang-browser-engine/react`).toBe(true);
      expect(hook in publicApi, `'${hook}' must NOT be in the core barrel (sub-path only)`).toBe(false);
    }
  });

  it("calls nothing that is not exported (broken-reference audit)", () => {
    expect(markdown).toBeDefined();
    if (!markdown) return;
    const calls = new Set<string>();
    for (const block of extractCodeBlocks(markdown)) {
      for (const match of block.matchAll(/(?:^|[^.\w])([A-Za-z_][A-Za-z0-9$_]*)\s*\(/gm)) {
        calls.add(match[1]!);
      }
    }
    const engine = { ...publicApi, ...reactApi };
    for (const call of calls) {
      if (NON_ENGINE_CALLS.has(call)) continue;
      expect(call in engine, `GUIDE.md snippet calls '${call}()' which is not a public engine API`).toBe(true);
    }
  });

  it("is linked from the README", () => {
    const readme = readFileSync(`${root}/README.md`, "utf8");
    expect(readme).toContain("GUIDE.md");
  });
});
