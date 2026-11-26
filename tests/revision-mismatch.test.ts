import { describe, expect, it } from "vitest";
import { parseYang, resolveModuleSet, compileYangModules } from "../src/index.js";
import { findSchemaLibraryMismatches, yangLibraryInventory } from "../src/internal.js";

async function compile(texts: string[]) {
  const set = await resolveModuleSet(texts.map(parseYang), { async loadModule() { return undefined; } });
  const schema = compileYangModules(set);
  expect(schema.diagnostics).toEqual([]);
  return schema;
}

const R1 = `module storage {
  namespace "urn:storage"; prefix s;
  revision 2026-03-01;
  container disks { leaf count { type uint8; } }
}`;

const R2 = `module storage {
  namespace "urn:storage"; prefix s;
  revision 2026-06-01;
  container disks { leaf count { type uint8; } }
}`;

const LIB_PAYLOAD = (rows: unknown) => ({ "ietf-yang-library:yang-library": { "module-set": [{ name: "device", module: rows }] } });

describe("precompiled schema ↔ device YANG Library revision check", () => {
  it("accepts a matching inventory silently", async () => {
    const schema = await compile([R1]);
    const inventory = yangLibraryInventory(LIB_PAYLOAD([
      { name: "storage", revision: "2026-03-01", namespace: "urn:storage", "conformance-type": "implement" },
    ]));
    expect(findSchemaLibraryMismatches(schema, inventory)).toEqual([]);
  });

  it("reports a revision drift naming both sides", async () => {
    const schema = await compile([R1]);
    const inventory = yangLibraryInventory(LIB_PAYLOAD([
      { name: "storage", revision: "2026-06-01", namespace: "urn:storage", "conformance-type": "implement" },
    ]));
    expect(findSchemaLibraryMismatches(schema, inventory)).toEqual([
      { name: "storage", kind: "different-revision", schemaRevision: "2026-03-01", libraryRevision: "2026-06-01" },
    ]);
  });

  it("reports modules the device no longer serves", async () => {
    const schema = await compile([R1, R2.replace("storage", "x-cache").replace("urn:storage", "urn:x-cache").replace("2026-06-01", "2026-02-01")]);
    const inventory = yangLibraryInventory(LIB_PAYLOAD([
      { name: "storage", revision: "2026-03-01", namespace: "urn:storage", "conformance-type": "implement" },
      // x-cache vanished from the device library.
    ]));
    const mismatches = findSchemaLibraryMismatches(schema, inventory);
    expect(mismatches).toEqual([
      { name: "x-cache", kind: "only-in-schema", schemaRevision: "2026-02-01", libraryRevision: undefined },
    ]);
  });

  it("reports implemented modules missing from the precompiled bundle", async () => {
    const schema = await compile([R1]);
    const inventory = yangLibraryInventory(LIB_PAYLOAD([
      { name: "storage", revision: "2026-03-01", namespace: "urn:storage", "conformance-type": "implement" },
      { name: "extra", revision: "2025-12-10", namespace: "urn:extra", "conformance-type": "implement" },
      { name: "ietf-inet-types", revision: "2013-07-15", namespace: "urn:ietf:params:xml:ns:yang:ietf-inet-types", "conformance-type": "import" },
    ]));
    // `ietf-inet-types` is import-only on the device: not an actionable
    // mismatch — the precompiled bundle already decided what it needs.
    expect(findSchemaLibraryMismatches(schema, inventory)).toEqual([
      { name: "extra", kind: "only-in-library", schemaRevision: undefined, libraryRevision: "2025-12-10" },
    ]);
  });

  it("checks submodules too", async () => {
    const schema = await compile([R1]);
    const set = await resolveModuleSet([parseYang(R1)], {
      async loadModule() { return undefined; },
      async loadSubmodule() { return undefined; },
    });
    const schema2 = compileYangModules(set);
    expect(schema2.diagnostics).toEqual([]);
    const inventory = yangLibraryInventory({
      "ietf-yang-library:yang-library": {
        "module-set": [{
          name: "device",
          module: [{ name: "storage", revision: "2026-03-01", namespace: "urn:storage", "conformance-type": "implement" }],
        }],
      },
    });
    // No submodules compiled, none in the library inventory.
    expect(findSchemaLibraryMismatches(schema2, inventory)).toEqual([]);
    // A drifted submodule is reported with both revisions.
    const withSubmodule = {
      modules: [{ name: "storage", revision: "2026-03-01", namespace: "urn:storage", "conformance-type": "implement" }],
      submodules: [{ name: "storage-types", revision: "2026-04-01" }],
    };
    const mismatched = findSchemaLibraryMismatches(schema2, withSubmodule);
    expect(mismatched).toEqual([
      { name: "storage-types", kind: "only-in-library", schemaRevision: undefined, libraryRevision: "2026-04-01" },
    ]);
  });
});
