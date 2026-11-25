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
    const pages = readdirSync(examplesDir).filter(name => name.endsWith(".html") && name !== "standalone.template.html");
    expect(pages.length).toBeGreaterThanOrEqual(2);
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

  // standalone.html must run from file:// (double-click) or Live Server, so it
  // may not rely on ES-module imports, network fetches, or external files.
  it("keeps standalone.html self-contained: embedded bundle, embedded schema, no external loads", async () => {
    const html = readFileSync(`${examplesDir}/standalone.html`, "utf8");
    expect(html).toContain("</html>");
    expect(html).not.toContain("<script type=\"module\"");
    expect(html).not.toMatch(/fetch\s*\(/, "standalone page must not fetch anything");
    for (const match of html.matchAll(/<script[^>]*(\ssrc=)?/g)) {
      expect(match[1], "standalone page must not load external scripts").toBeUndefined();
    }
    expect(html).toContain("YangEngine");
    // The embedded schema must be the real oven schema, escaped for embedding.
    const decoded = JSON.parse(html.match(/const OVEN_YANG = ("(?:[^"\\]|\\.)*");/s)![1]!);
    expect(decoded).toBe(readFileSync(`${examplesDir}/oven.yang`, "utf8"));
    // No unresolved placeholders from the build step.
    expect(html).not.toContain("/*__ENGINE__*/");
    expect(html).not.toContain("/*__YANG__*/");
  });

  // The standalone page builds its controls at runtime, so the coverage check
  // executes the generated page against a minimal DOM shim.
  it("covers every node of the oven module in the standalone page", async () => {
    const { parseYang, createFormModel } = await import("../src/index.js");
    const yang = readFileSync(`${examplesDir}/oven.yang`, "utf8");
    const form = createFormModel(parseYang(yang));

    const html = readFileSync(`${examplesDir}/standalone.html`, "utf8");
    const opening = html.lastIndexOf("<script>\n      \"use strict\";");
    expect(opening, "standalone.html must keep its inline script").toBeGreaterThan(-1);
    const script = html.slice(html.indexOf(">", opening) + 1, html.indexOf("</script>", opening));

    const byId = new Map<string, any>();
    const makeEl = (): any => {
      const el: any = {
        id: "", value: "", checked: false, title: "", listeners: {}, children: [],
        append() {},
        addEventListener(type: string, fn: (event: { type: string }) => void) { (el.listeners[type] ??= []).push(fn); },
        dispatch(event: { type: string }) { for (const fn of el.listeners[event.type] ?? []) fn(event); },
        setAttribute(name: string, value: string) { if (name === "id") { el.id = value; byId.set(value, el); } },
      };
      return el;
    };
    byId.set("app", makeEl());
    const result = makeEl();
    byId.set("result", result);
    const document = {
      querySelector: (selector: string) => byId.get(selector.slice(1)) ?? null,
      createElement: makeEl,
      createTextNode: (text: string) => ({ text }),
    };
    const Event = class { constructor(type: string) { (this as { type: string }).type = type; } };
    new Function("document", "Event", script)(document, Event);

    expect(result.textContent).toBe("Ready. Edit the fields, then preview requests below.");
    for (const field of form.fields) {
      const id = field.path.split("/").filter(Boolean).join("-");
      expect(byId.get(`input-${id}`), `${field.path} must have a control`).toBeDefined();
      expect(byId.get(`status-${id}`), `${field.path} must have a status`).toBeDefined();
    }
    // Range constraint from the typedef is enforced live in the page.
    const temperature = byId.get("input-oven-temperature");
    const bounds: readonly [string, RegExp | string][] = [["300", /0\.\.250|uint8/], ["251", /0\.\.250/], ["250", "OK"]];
    for (const [value, expected] of bounds) {
      temperature.value = value;
      temperature.dispatch({ type: "input" });
      expect(byId.get("status-oven-temperature").textContent, `temperature ${value}`)
        .toEqual(expect.stringMatching(expected));
    }
    // Configuration preview: PUT carries the entered values.
    temperature.value = "180";
    temperature.dispatch({ type: "input" });
    byId.get("preview-put").dispatch({ type: "click" });
    expect(result.textContent).toContain("PUT");
    expect(result.textContent).toContain("/restconf/data/oven:oven");
    expect(result.textContent).toContain('"temperature": 180');
    // State preview: operational datastore with origin data.
    byId.get("preview-state-get").dispatch({ type: "click" });
    expect(result.textContent).toContain("/restconf/ds/ietf-datastores:operational/oven:oven-state?with-origin");
    // RPCs: insert-food (with input) and remove-food (no body).
    byId.get("preview-rpc-insert-food").dispatch({ type: "click" });
    expect(result.textContent).toContain("/restconf/operations/oven:insert-food");
    expect(result.textContent).toContain('"oven:input"');
    byId.get("preview-rpc-remove-food").dispatch({ type: "click" });
    expect(result.textContent).toContain("/restconf/operations/oven:remove-food");
    expect(result.textContent).not.toContain("oven:input");
    // Notifications named in the schema are surfaced in the page.
    expect(byId.get("notification-note"), "notification oven-ready must be listed").toBeDefined();
  });
});
