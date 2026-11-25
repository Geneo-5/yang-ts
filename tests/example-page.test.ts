import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const examplesDir = fileURLToPath(new URL("../examples", import.meta.url));
const root = fileURLToPath(new URL("..", import.meta.url));

// The example pages are user-facing smoke surfaces and ship in the package:
// they import named symbols from ../dist/index.js and fetch local fixtures.
// These guards keep them from going stale unnoticed again.
describe("example pages", () => {
  beforeAll(() => {
    if (!existsSync(`${root}/dist/index.js`)) throw new Error("dist/index.js is missing: run `npm run build` first");
  });

  it("imports only symbols that the built bundle actually exports and fetches only existing files", async () => {
    const bundle = await import(`${root}/dist/index.js`) as Record<string, unknown>;
    const pages = readdirSync(examplesDir).filter(name => name.endsWith(".html"));
    expect(pages.length).toBeGreaterThanOrEqual(1);
    for (const page of pages) {
      const html = readFileSync(`${examplesDir}/${page}`, "utf8");
      expect(html, `${page} must be a complete document`).toContain("</html>");
      // Named imports from the dist bundle.
      for (const match of html.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)) {
        const target = match[2]!;
        if (target.endsWith("dist/index.js")) {
          expect(target.startsWith("/"), `${page} must import dist by relative path`).toBe(false);
          for (const symbol of match[1]!.split(",").map(item => item.trim()).filter(Boolean)) {
            expect(bundle, `${page} imports unknown symbol '${symbol}' from dist`).toHaveProperty(symbol);
          }
        }
      }
      // Relative fetch targets resolve inside the shipped examples folder.
      for (const match of html.matchAll(/fetch\("(\.\/[^"]+|\.\.\/[^"]+)"\)/g)) {
        const target = match[1]!;
        expect(existsSync(`${examplesDir}/${target}`), `${page} fetches missing file ${target}`).toBe(true);
      }
    }
  });

  it("keeps the shipped oven fixture in sync with the test fixture", () => {
    const shipped = readFileSync(`${examplesDir}/oven.yang`, "utf8");
    const fixture = readFileSync(`${root}/tests/fixtures/yang/sysrepo/oven.yang`, "utf8");
    expect(shipped).toBe(fixture);
  });
});
