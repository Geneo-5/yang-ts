import * as publicApi from "../src/index.js";
import * as internalApi from "../src/internal.js";
import { describe, expect, it } from "vitest";

/**
 * The public barrel of the package is exactly the documented surface: the
 * core pipeline, the form helper, data-tree validation and the RESTCONF
 * helpers that never perform network requests. Internal helpers live in
 * `src/internal.ts` and are reachable by deep imports only.
 */
const PUBLIC_VALUES = [
  "parseYang", "YangSyntaxError", "resolveModuleSet", "compileYangModules",
  "serializeCompiledSchema", "deserializeCompiledSchema", "CompiledSchemaFormatError",
  "createFormModel", "validateFormValue", "canonicalFormOf",
  "formValuesToRestconfBody", "formInputToRestconfBody", "formPathToYangPathSegments",
  "validateDataTree", "evaluateCandidates", "buildAccessibleTree", "createConstraintEvaluator",
  "createRestconfModuleLoader", "findSchemaLibraryMismatches", "yangLibraryInventory", "yangJsonToDocument", "documentToYangJson", "YangJsonError",
  "createRestconfGetRequest", "createRestconfDatastoreRequest", "createRestconfNmdaProbeRequest",
  "createRestconfSetRequest", "createRestconfAddRequest", "createRestconfUpdateRequest", "createRestconfDeleteRequest",
  "createRestconfRpcRequest", "readRestconfData", "readRestconfRpcOutput",
  "nodeToRestconfDataPath", "nodeToRestconfDatastorePath", "restconfRpcPath", "nodeToXPath",
  "capabilities",
];

const INTERNAL_ONLY = [
  "qualifyYangXPathNodeTests", "compileYangXPath", "compileModuleExpression",
  "createYangFunctionLibrary", "createLeafrefResolver", "leafrefPathStatementOf",
  "xmlNamespaceForPrefix", "matchSchemaChild", "schemaNodeForElement", "accessibleDataRoot",
  "flattenDataChildren", "findSchemaNodeByPath", "schemaNodeChainByPath",
  "childOf", "childrenOf", "moduleNamespacePrefixes", "documentNamespacePrefixes", "yangLibraryEntries",
  "BUILTIN_TYPES", "RESTRICTION_BUILTINS", "compileXsdPattern", "finiteDomainOf",
  "UNTRUSTED_MODULE_BUDGET", "UNTRUSTED_SCHEMA_NODE_BUDGET",
  "COMPILED_SCHEMA_FORMAT", "COMPILED_SCHEMA_VERSION",
];

describe("curated public API barrel", () => {
  it("exports exactly the documented public surface", () => {
    expect(Object.keys(publicApi).filter(name => name !== "EngineCapabilities").sort()).toEqual([...PUBLIC_VALUES].sort());
  });

  it("gives every public export a runtime name and capabilities an honest shape", () => {
    for (const name of PUBLIC_VALUES.filter(value => value !== "capabilities")) {
      expect(typeof (publicApi as Record<string, unknown>)[name]).toBe("function");
    }
    expect(publicApi.capabilities).toEqual({
      parser: "implemented", moduleResolution: "implemented", xpath: "implemented",
      validation: "partial", browserOnlyRuntime: true,
    });
  });

  it("keeps internal helpers out of the public barrel", () => {
    for (const helper of INTERNAL_ONLY) {
      expect(helper in publicApi, `'${helper}' must stay internal`).toBe(false);
      expect(helper in internalApi, `'${helper}' must stay reachable from src/internal.ts`).toBe(true);
    }
  });
});
