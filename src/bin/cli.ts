#!/usr/bin/env node
/**
 * `yang-browser-engine` CLI — currently the `precompile` command of Roadmap
 * 8.1: compile YANG sources (with enabled features) at build time and write
 * the loadable artifacts to a directory the browser can serve:
 *
 *   yang-browser-engine precompile <sources.yang>... [--features a:f,b:g] [--out <dir>]
 *
 * Writes `yang-schema.json` (the versioned serialized schema),
 * `yang-modules/<name>@<revision>.yang` (module texts for the browser-side
 * fallback) and `yang-manifest.json` describing both.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseYang, childOf } from "../yang/parser.js";
import { resolveModuleSet } from "../yang/module-set.js";
import { compileYangModules } from "../yang/compiler.js";
import { serializeCompiledSchema, COMPILED_SCHEMA_FORMAT } from "../yang/serialization.js";
import type { YangModule } from "../yang/ast.js";

const USAGE = `usage: yang-browser-engine precompile <sources.yang>... [--features module:feature,...] [--out <dir>]

Compiles YANG module sources into the artifacts a browser loads directly:
  yang-schema.json    the versioned serialized CompiledYangSchema
  yang-modules/…      the module texts (for the runtime fallback loader)
  yang-manifest.json  module inventory: name, revision, namespace, file

Exit codes: 0 ok, 1 usage or missing files, 2 YANG/compile errors.`;

interface Invocation {
  command: "precompile";
  sources: string[];
  features: Set<string>;
  outDir: string;
}

function die(message: string, code: 1 | 2): never {
  if (message) process.stderr.write(`${message}\n`);
  process.exit(code);
}

const revisionOf = (module: YangModule): string => childOf(module, "revision")?.argument ?? "";

function parseInvocation(argv: readonly string[]): Invocation {
  if (argv.includes("--help")) die(USAGE, 1);
  const [command, ...rest] = argv;
  if (command !== "precompile") die(USAGE, 1);
  const sources: string[] = [];
  let features = new Set<string>();
  let outDir = "public";
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "--features") {
      const value = rest[index + 1];
      if (value === undefined) die("usage: --features expects a comma-separated module:feature list", 1);
      features = new Set(value.split(",").map(entry => entry.trim()).filter(entry => entry.length > 0));
      index += 1;
    } else if (arg === "--out") {
      const value = rest[index + 1];
      if (value === undefined) die("usage: --out expects a directory", 1);
      outDir = value;
      index += 1;
    } else if (arg.startsWith("--")) {
      die(USAGE, 1);
    } else {
      sources.push(arg);
    }
  }
  if (sources.length === 0) die(USAGE, 1);
  return { command: "precompile", sources, features, outDir };
}

async function main(): Promise<void> {
  const invocation = parseInvocation(process.argv.slice(2));

  const texts: { file: string; text: string }[] = [];
  for (const file of invocation.sources) {
    try {
      texts.push({ file, text: await readFile(file, "utf8") });
    } catch (error) {
      die(`cannot read '${file}': ${String((error as NodeJS.ErrnoException).message ?? error)}`, 1);
    }
  }

  const parsed: YangModule[] = [];
  for (const { file, text } of texts) {
    try {
      parsed.push(parseYang(text));
    } catch (error) {
      die(`${file}: ${(error as Error).message}`, 2);
    }
  }

  const roots = parsed.filter(module => module.keyword === "module");
  // Imports resolve against the given files first (a self-contained set),
  // falling back to no loader: a missing import is a set diagnostic.
  const newestOf = (kind: "module" | "submodule", name: string, pinned?: string): YangModule | undefined => {
    const candidates = parsed.filter(entry => entry.keyword === kind && entry.argument === name);
    const pinnedMatch = pinned ? candidates.find(entry => revisionOf(entry) === pinned) : undefined;
    if (pinnedMatch) return pinnedMatch;
    return candidates.sort((a, b) => revisionOf(b).localeCompare(revisionOf(a)))[0];
  };
  const set = await resolveModuleSet(roots, {
    async loadModule(name, pinned) { return newestOf("module", name, pinned); },
    async loadSubmodule(name, pinned) { return newestOf("submodule", name, pinned); },
  });
  for (const diagnostic of set.diagnostics) {
    const location = diagnostic.sourceLocation;
    process.stderr.write(`${diagnostic.sourceModule ?? diagnostic.code}: ${diagnostic.code}: ${diagnostic.message} (${location.line}:${location.column})\n`);
  }
  if (set.diagnostics.length > 0) die("", 2);

  const schema = compileYangModules(set, {
    ...(invocation.features.size > 0 ? { enabledFeatures: invocation.features } : {}),
  });
  if (schema.diagnostics.length > 0) {
    for (const diagnostic of schema.diagnostics) {
      const location = diagnostic.source.location;
      process.stderr.write(`${diagnostic.module}: ${diagnostic.code}: ${diagnostic.message} (${location.line}:${location.column})\n`);
    }
    die("", 2);
  }
  if (schema.roots.length === 0) die("no data trees compiled from the given sources", 2);

  const payload = serializeCompiledSchema(schema);
  const payloadText = `${JSON.stringify(payload, null, 2)}\n`;

  await mkdir(join(invocation.outDir, "yang-modules"), { recursive: true });
  const manifest: {
    format: string; version: number; schemaFile: string;
    modules: { name: string; revision: string; namespace: string; file: string }[];
  } = {
    format: COMPILED_SCHEMA_FORMAT,
    version: payload.version,
    schemaFile: "yang-schema.json",
    modules: [],
  };
  const names = new Set(schema.modules.map(module => module.argument));
  const sourceByModule = new Map<string, string>();
  for (let index = 0; index < parsed.length; index += 1) {
    const module = parsed[index]!;
    const text = texts[index]!.text;
    const id = `${module.argument}@${revisionOf(module)}`;
    if (sourceByModule.has(id)) die(`module '${module.argument}@${revisionOf(module)}' is given by two sources`, 2);
    sourceByModule.set(id, text);
  }
  for (const module of schema.modules) {
    const revision = revisionOf(module);
    const file = `yang-modules/${module.argument}${revision ? `@${revision}` : ""}.yang`;
    const sourceText = sourceByModule.get(`${module.argument}@${revision}`);
    if (sourceText === undefined) die(`no source text for module '${module.argument}@${revision}'`, 2);
    await writeFile(join(invocation.outDir, file), sourceText);
    manifest.modules.push({
      name: module.argument,
      revision,
      namespace: childOf(module, "namespace")?.argument ?? "",
      file,
    });
  }
  await writeFile(join(invocation.outDir, "yang-schema.json"), payloadText);
  await writeFile(join(invocation.outDir, "yang-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(
    `wrote yang-schema.json (${payloadText.length} bytes) and ${manifest.modules.length} module texts to ${invocation.outDir}\n`,
  );
}

main().catch(error => die(String(error), 2));
