import type { CompiledYangSchema } from "../yang/compiler.js";
import type { YangModule } from "../yang/ast.js";
import { childOf } from "../yang/parser.js";
import type { YangLibraryInventory } from "./library-loader.js";

export interface SchemaRevisionMismatch {
  name: string;
  kind: "different-revision" | "only-in-schema" | "only-in-library";
  /** Revision the precompiled bundle carries, if any. */
  schemaRevision?: string | undefined;
  /** Revision the device's YANG Library reports, if any. */
  libraryRevision?: string | undefined;
}

const revisionOf = (module: YangModule): string | undefined => childOf(module, "revision")?.argument || undefined;

/**
 * Compare a precompiled schema (or any `CompiledYangSchema`) with the
 * module inventory a device reports (RFC 7895/8525 payloads parsed by
 * `yangLibraryInventory`). Returns one entry per actionable difference:
 * a revision the device serves that the bundle does not carry
 * (`different-revision`), a module the device dropped
 * (`only-in-schema`), or an `implement` module the precompiled bundle
 * lacks (`only-in-library` — forms cannot be built for it). Device modules
 * with `conformance: import` are never reported: the bundle already
 * decided what it needs, and imports constrain form building nothing.
 * The page decides what to do — switch to the discovered-schema loader
 * path, warn, or refuse.
 */
export function findSchemaLibraryMismatches(
  schema: CompiledYangSchema,
  inventory: YangLibraryInventory,
): SchemaRevisionMismatch[] {
  const libraryByModule = new Map(inventory.modules.map(entry => [entry.name, entry]));
  const libraryBySubmodule = new Map(inventory.submodules.map(entry => [entry.name, entry]));
  const mismatches: SchemaRevisionMismatch[] = [];
  const compare = (
    name: string,
    schemaRevision: string | undefined,
    libraryRevision: string | undefined,
  ): void => {
    if (schemaRevision === undefined && libraryRevision === undefined) return;
    if (schemaRevision !== undefined && libraryRevision === undefined) {
      mismatches.push({ name, kind: "only-in-schema", schemaRevision });
      return;
    }
    if (schemaRevision === undefined && libraryRevision !== undefined) {
      mismatches.push({ name, kind: "only-in-library", libraryRevision });
      return;
    }
    if (schemaRevision !== libraryRevision) {
      mismatches.push({ name, kind: "different-revision", schemaRevision, libraryRevision });
    }
  };
  for (const module of schema.modules) compare(module.argument, revisionOf(module), libraryByModule.get(module.argument)?.revision);
  for (const submodule of schema.submodules) compare(submodule.argument, revisionOf(submodule), libraryBySubmodule.get(submodule.argument)?.revision);
  const compiledNames = new Set([
    ...schema.modules.map(module => module.argument),
    ...schema.submodules.map(submodule => submodule.argument),
  ]);
  for (const entry of inventory.modules) {
    if (compiledNames.has(entry.name)) continue;
    // Only `implement` modules are actionable: an import-only device module
    // never needs forms of its own.
    if (entry.conformance === "import") continue;
    mismatches.push({ name: entry.name, kind: "only-in-library", libraryRevision: entry.revision });
  }
  for (const entry of inventory.submodules) {
    if (compiledNames.has(entry.name)) continue;
    if (entry.conformance === "import") continue;
    mismatches.push({ name: entry.name, kind: "only-in-library", libraryRevision: entry.revision });
  }
  return mismatches.sort((a, b) => a.name.localeCompare(b.name));
}
