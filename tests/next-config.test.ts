import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withYangEngine, type YangNextConfig } from "../src/next/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("withYangEngine (roadmap Stage 8.5)", () => {
  it("defaults to a static export with unoptimized images and keeps every other key", () => {
    const config = withYangEngine({ reactStrictMode: true, experimental: { esmExternals: true } });
    expect(config.output).toBe("export");
    expect(config.images).toEqual({ unoptimized: true });
    expect(config.reactStrictMode).toBe(true);
    expect((config.experimental as { esmExternals: boolean }).esmExternals).toBe(true);
    // Nothing invented beyond the export-only needs (no server runtime, no rewrites).
    expect(Object.keys(config).sort()).toEqual(["experimental", "images", "output", "reactStrictMode"]);
  });

  it("refuses builds that contradict the static export it stands for", () => {
    expect(() => withYangEngine({ output: "standalone" })).toThrow(/output.*export/);
    expect(() => withYangEngine({ images: { unoptimized: false } })).toThrow(/unoptimized/);
  });

  it("never mutates the caller's config object", () => {
    const original: YangNextConfig = { basePath: "/app", images: { quality: 70 } };
    const snapshot = JSON.stringify(original);
    withYangEngine(original, { basePath: "/other" });
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("applies the basePath option to basePath and assetPrefix without overriding explicit caller values", () => {
    const configured = withYangEngine(undefined, { basePath: "/yang-console" });
    expect(configured.basePath).toBe("/yang-console");
    expect(configured.assetPrefix).toBe("/yang-console");

    const passthrough = withYangEngine(
      { basePath: "/site", assetPrefix: "https://cdn.example.com/site" },
      { basePath: "/ignored" },
    );
    expect(passthrough.basePath).toBe("/site");
    expect(passthrough.assetPrefix).toBe("https://cdn.example.com/site");
  });

  it("works with no arguments", () => {
    expect(withYangEngine().output).toBe("export");
    expect(withYangEngine().images).toEqual({ unoptimized: true });
  });

  it("is a plain build-time transform: no next import, no require, no eval", () => {
    const source = readFileSync(`${root}/src/next/config.ts`, "utf8");
    expect(source.includes("from \"next")).toBe(false);
    expect(source.includes("require(")).toBe(false);
    expect(/new Function|eval\(/.test(source)).toBe(false);
  });

  it("adds the documented ./next sub-path to the package exports", () => {
    const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as {
      exports: Record<string, { types: string; import: string }>;
    };
    expect(pkg.exports["./next"]).toEqual({ types: "./dist/next/index.d.ts", import: "./dist/next/index.js" });
  });
});
