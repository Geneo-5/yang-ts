import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Real-browser run (Roadmap P3): the standalone example page bundles the
 * engine as an IIFE behind the `YangEngine` global and runs from any static
 * server or file://. This suite launches headless Chromium through Playwright,
 * loads that page and drives the engine inside the browser's own DOM —
 * proving the bundle needs no Node built-ins, no fetch and no Python.
 *
 * Skipped with a clear reason when Chromium is not installed
 * (`npx playwright install chromium` is a dev-time action; it is never a
 * runtime requirement for consumers of the package).
 */

let chromiumAvailable = false;
const chromiumExecutableStatus = async (): Promise<{ available: boolean; reason: string }> => {
  try {
    const { chromium } = await import("playwright");
    return { available: Boolean(chromium.executablePath()), reason: "playwright chromium executable missing (npx playwright install chromium)" };
  } catch {
    return { available: false, reason: "playwright not installed (npm install --save-dev playwright && npx playwright install chromium)" };
  }
};

const root = fileURLToPath(new URL("..", import.meta.url));

let server: { url: string; close: () => Promise<unknown> } | undefined;
let browser: Browser | undefined;

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = createServer(async (request, response) => {
    try {
      const relative = (request.url ?? "/").split("?")[0]!.replace(/^\//, "");
      const target = relative.length === 0 ? "examples/standalone.html" : relative;
      if (!target.startsWith("examples/") || target.includes("..")) throw new Error("forbidden");
      const body = await readFile(`${root}${target}`);
      response.writeHead(200, { "content-type": target.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>(resolve => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/examples/standalone.html`, close: () => new Promise(resolve => httpServer.close(() => resolve())) };
}

describe("real-browser run of the standalone example (Playwright headless Chromium)", async () => {
  const status = await chromiumExecutableStatus();
  chromiumAvailable = status.available;
  // eslint-disable-next-line no-console
  if (!chromiumAvailable) console.warn(`Skipping real-browser suite: ${status.reason}`);

  beforeAll(async () => {
    if (!chromiumAvailable) return;
    server = await startServer();
    browser = await (await import("playwright")).chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.skipIf(!existsSync(new URL("../examples/standalone.html", import.meta.url)))("has a built standalone page", () => {
    expect(existsSync(new URL("../examples/standalone.html", import.meta.url))).toBe(true);
  });

  it("renders the oven form from the bundled engine inside Chromium", async () => {
    if (!chromiumAvailable || !server || !browser) return;
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(server.url);
    // The page renders a field per leaf of the oven model.
    await page.waitForSelector("#app section .field", { timeout: 5000 });
    expect(await page.textContent("#result")).not.toContain("Error:");
    expect(errors).toEqual([]);
    // Native browser DOM is used (no xmldom): the page built inputs itself.
    expect(await page.locator("#app input, #app select").count()).toBeGreaterThan(0);
    await page.close();
  });

  it("compiles and validates a data tree with the browser's own DOM parser", async () => {
    if (!chromiumAvailable || !server || !browser) return;
    const page = await browser.newPage();
    await page.goto(server.url);
    const outcome = await page.evaluate(async () => {
      const engine = (globalThis as unknown as {
        YangEngine: {
          parseYang: (source: string) => unknown;
          resolveModuleSet: (roots: readonly unknown[], loader?: unknown) => Promise<unknown>;
          compileYangModules: (moduleSet: unknown) => unknown;
          validateDataTree: (schema: unknown, document: Document) => { status: string; issues: Array<{ code: string }> };
          capabilities: { browserOnlyRuntime: boolean };
        };
      }).YangEngine;
      const schema = engine.compileYangModules(
        await engine.resolveModuleSet([engine.parseYang(`module probe {
        namespace "urn:probe"; prefix p;
        container oven { leaf temperature { type uint8; mandatory true; } }
      }`)]));
      // Validated against the browser's native DOMParser: the instance doc is
      // parsed by window.DOMParser, then validated by the engine.
      const document = new DOMParser().parseFromString(
        `<oven xmlns="urn:probe"></oven>`, "application/xml");
      const validated = engine.validateDataTree(schema, document) as { status: string; issues: Array<{ code: string }> };
      const ok = new DOMParser().parseFromString(
        `<oven xmlns="urn:probe"><temperature>100</temperature></oven>`, "application/xml");
      const accepted = engine.validateDataTree(schema, ok) as { status: string; issues: Array<{ code: string }> };
      return {
        capabilities: engine.capabilities as { browserOnlyRuntime: boolean },
        issues: validated.issues.map(issue => issue.code),
        acceptedStatus: accepted.status,
      };
    });
    expect(outcome.capabilities.browserOnlyRuntime).toBe(true);
    expect(outcome.issues).toEqual(["missing-mandatory"]);
    expect(outcome.acceptedStatus).toBe("valid");
    await page.close();
  });
});
