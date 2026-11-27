// Generates examples/standalone.html: a single self-contained page that runs
// from file:// (double-click) or any static server, including the VS Code
// Live Server extension. Browsers block ES-module imports and fetch() on
// file: pages, so the engine is bundled into a classic IIFE script and the
// YANG source is embedded inline instead of fetched.
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "examples", "standalone.html");
const template = path.join(root, "examples", "standalone.template.html");

const yang = await readFile(path.join(root, "examples", "oven.yang"), "utf8");
const embeddedYang = JSON.stringify(yang).replace(/</g, "\\u003c");

const { outputFiles } = await build({
  entryPoints: [path.join(root, "src", "index.ts")],
  bundle: true,
  format: "iife",
  globalName: "YangEngine",
  target: "es2020",
  write: false,
  logLevel: "silent",
});
const engine = outputFiles[0].text;

let html = await readFile(template, "utf8");
// Use replacement functions: a plain string would interpret $&/$' sequences
// present in the generated code.
html = html.replace("/*__ENGINE__*/", () => engine).replace("/*__YANG__*/", () => embeddedYang);
if (html.includes("/*__ENGINE__*/") || html.includes("/*__YANG__*/")) {
  throw new Error("Failed to inject the engine bundle or the YANG source into the template");
}
await writeFile(output, html);
console.log(`Wrote ${path.relative(root, output)} (${(html.length / 1024).toFixed(0)} kB)`);

// Also generate a Next.js static-export example with the engine embedded inline.
const nextAppOutput = path.join(root, "examples", "next-static-app.html");
const { outputFiles: nextFiles } = await build({
  entryPoints: [path.join(root, "src", "index.ts")],
  bundle: true,
  format: "iife",
  globalName: "YangEngine",
  target: "es2020",
  write: false,
  logLevel: "silent",
});
const nextEngine = nextFiles[0].text;
const nextTemplate = path.join(root, "examples", "next-static-app.template.html");
let nextHtml = await readFile(nextTemplate, "utf8");
nextHtml = nextHtml.replace("/*__ENGINE__*/", () => nextEngine);
if (nextHtml.includes("/*__ENGINE__*/")) {
  throw new Error("Failed to inject the engine bundle into the Next.js app template");
}
await writeFile(nextAppOutput, nextHtml);
console.log(`Wrote ${path.relative(root, nextAppOutput)} (${(nextHtml.length / 1024).toFixed(0)} kB)`);
