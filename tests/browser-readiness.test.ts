import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

function walk(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = `${directory}/${entry}`;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") || (full.endsWith(".js") && !full.endsWith(".d.ts"))) out.push(full);
  }
  return out;
}

/** Browser-only runtime: nothing in the package may reach for a Node-only global or module. */
const FORBIDDEN = [
  /\bfrom\s+["']node:/,
  /\brequire\(/,
  /\bprocess\.env\b/,
  /\bprocess\.(platform|version|argv)\b/,
  /\bBuffer\b/,
  /\bchild_process\b/,
  /\bos\.(homedir|platform)\(/,
];

describe("browser readiness audit", () => {
  it("keeps every shipped source file free of Node built-ins and globals", () => {
    const sources = [...walk(`${root}/src`), ...(existsSync(`${root}/dist`) ? walk(`${root}/dist`) : [])];
    expect(sources.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("ships exactly the documented package surface", () => {
    const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as {
      files: string[]; exports: Record<string, Record<string, string>>; sideEffects: boolean; type: string;
    };
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.type).toBe("module");
    expect(Object.keys(pkg.exports)).toEqual(["."]);
    expect(pkg.exports["."]).toMatchObject({ types: "./dist/index.d.ts", import: "./dist/index.js" });
    const missing = (pkg.files as string[]).filter(entry => !existsSync(`${root}/${entry}`));
    // `dist` only exists after a build; every other declared file must be checked in.
    expect(missing.filter(entry => entry !== "dist")).toEqual([]);
  });

  it("exports only the browser-safe dependency for XPath evaluation", () => {
    const pkgDeps = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkgDeps.dependencies)).toEqual(["xpath"]);
    const xpathPackage = JSON.parse(readFileSync(`${root}/node_modules/xpath/package.json`, "utf8")) as {
      main?: string; browser?: string | Record<string, string>;
    };
    expect(xpathPackage.browser).toBeUndefined;
    if (xpathPackage.main) {
      const entry = readFileSync(`${root}/node_modules/xpath/${xpathPackage.main}`, "utf8");
      expect(/\brequire\(/.test(entry) || /\bfrom ["']node:/.test(entry)).toBe(false);
    }
  });
});
