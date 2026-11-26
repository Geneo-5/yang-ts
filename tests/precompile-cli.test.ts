import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { parseYang, resolveModuleSet, deserializeCompiledSchema } from "../src/index.js";
import { compileYangModules } from "../src/internal.js";

interface RunResult { code: number; stdout: string; stderr: string }
type ExecFileUtf8 = (file: string, args: string[], options?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;
const run = promisify(execFile) as unknown as ExecFileUtf8;
const CLI = join(import.meta.dirname, "..", "dist", "bin", "cli.js");

const OVEN = `module oven {
  namespace "urn:oven"; prefix o;
  revision 2026-01-15;
  feature self-clean;
  feature steam;
  container state {
    leaf temperature { type int16 { range "-50..300"; } }
    leaf mode { type enumeration { enum off; enum bake; enum grill; } }
    leaf cleaning { if-feature self-clean; type boolean; default false; }
    leaf steam-rack { if-feature steam; type boolean; default false; }
  }
  rpc start { input { leaf minutes { type uint16; } } }
}`;

const OVEN2 = `module oven-ext {
  namespace "urn:oven-ext"; prefix x;
  import oven { prefix o; }
  augment "/o:state" { leaf preheat { type boolean; } }
}`;

const workspaces: string[] = [];
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "precompile-"));
  workspaces.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(workspaces.map(dir => rm(dir, { recursive: true, force: true })));
});

interface RunResult { code: number; stdout: string; stderr: string }
async function cli(args: string[], cwd?: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await run("node", [CLI, ...args], cwd ? { cwd } : undefined);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("precompile CLI", () => {
  it("compiles YANG sources and feature flags into a loadable schema bundle", async () => {
    const dir = await workspace();
    const ovenPath = join(dir, "oven.yang");
    const extPath = join(dir, "oven-ext.yang");
    await writeFile(ovenPath, OVEN);
    await writeFile(extPath, OVEN2);

    const result = await cli(["precompile", ovenPath, extPath, "--features", "oven:self-clean", "--out", dir]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    // The schema file loads through the public deserializer without the parser.
    const envelope = JSON.parse(await readFile(join(dir, "yang-schema.json"), "utf8"));
    const revived = deserializeCompiledSchema(envelope);
    const set = await resolveModuleSet([parseYang(OVEN), parseYang(OVEN2)], { async loadModule() { return undefined; } });
    const compiled = compileYangModules(set, { enabledFeatures: new Set(["oven:self-clean"]) });
    expect(revived).toEqual(compiled);
    // Feature selection took effect: cleaning stays, steam-rack drops.
    const state = revived.roots.find(root => root.name === "state")!;
    expect(state.children.some(child => child.name === "cleaning")).toBe(true);
    expect(state.children.some(child => child.name === "steam-rack")).toBe(false);

    // Manifest and module texts for the runtime fallback (ROADMAP 8.1).
    const manifest = JSON.parse(await readFile(join(dir, "yang-manifest.json"), "utf8"));
    expect(manifest.schemaFile).toBe("yang-schema.json");
    const ovenEntry = manifest.modules.find((entry: { name: string }) => entry.name === "oven")!;
    expect(ovenEntry.revision).toBe("2026-01-15");
    expect(ovenEntry.namespace).toBe("urn:oven");
    expect(ovenEntry.file).toBe("yang-modules/oven@2026-01-15.yang");
    const text = await readFile(join(dir, ovenEntry.file), "utf8");
    expect(text).toBe(OVEN);
  });

  it("without --features, every feature-gated node stays (features default to available)", async () => {
    const dir = await workspace();
    const ovenPath = join(dir, "oven.yang");
    await writeFile(ovenPath, OVEN);
    const result = await cli(["precompile", ovenPath, "--out", dir]);
    expect(result.code).toBe(0);
    const envelope = JSON.parse(await readFile(join(dir, "yang-schema.json"), "utf8"));
    const state = deserializeCompiledSchema(envelope).roots.find(root => root.name === "state")!;
    expect(state.children.some(child => child.name === "cleaning")).toBe(true);
    expect(state.children.some(child => child.name === "steam-rack")).toBe(true);
  });

  it("fails the build (exit 2, no schema written) on compile diagnostics", async () => {
    const dir = await workspace();
    const brokenPath = join(dir, "broken.yang");
    await writeFile(brokenPath, `module broken {
      namespace "urn:broken"; prefix b;
      container twice { leaf dup { type string; } leaf dup { type int8; } }
    }`);
    const result = await cli(["precompile", brokenPath, "--out", dir]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("duplicate-node");
    await expect(readFile(join(dir, "yang-schema.json"), "utf8")).rejects.toThrow();
  });

  it("reports parse errors with their location", async () => {
    const dir = await workspace();
    const badPath = join(dir, "bad.yang");
    await writeFile(badPath, `module bad { namespace "urn:bad"; prefix b; leaf x { type string }`);
    const result = await cli(["precompile", badPath, "--out", dir]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/bad\.yang.*\d+:\d+|Expected.*;/s);
  });

  it("explains usage when invoked wrongly", async () => {
    const result = await cli([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("usage");
    const noSources = await cli(["precompile"]);
    expect(noSources.code).toBe(1);
  });
});
