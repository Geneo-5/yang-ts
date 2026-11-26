import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const output = path.resolve("examples/next-static/out");
const budget = 256 * 1024;
const marker = "YANG Library payload has no module list";

async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(file));
    else result.push(file);
  }
  return result;
}

const files = await filesUnder(output);
const htmlPath = path.join(output, "index.html");
if (!files.includes(htmlPath)) throw new Error("Static export is missing out/index.html");
const forbidden = files.filter(file => /(?:\.nft\.json|\/server\/|\.node$)/.test(file));
if (forbidden.length) throw new Error(`Server runtime artifacts found in static export: ${forbidden.join(", ")}`);

const engineChunks = [];
for (const file of files.filter(file => file.endsWith(".js"))) {
  const source = await readFile(file, "utf8");
  if (source.includes(marker)) engineChunks.push({ file, source, size: (await stat(file)).size });
}
if (engineChunks.length !== 1) throw new Error(`Expected one dynamically split engine chunk, found ${engineChunks.length}`);
if (engineChunks[0].size > budget) {
  throw new Error(`Engine chunk is ${(engineChunks[0].size / 1024).toFixed(1)} KiB; budget is ${budget / 1024} KiB`);
}

const html = await readFile(htmlPath, "utf8");
if (html.includes(marker)) throw new Error("Engine code was included in the prerendered HTML");
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");
const initialScripts = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map(match => match[1]);
if (initialScripts.length === 0) throw new Error("Prerendered page does not reference any JavaScript chunks");
for (const script of initialScripts) {
  const scriptPath = new URL(script, "http://localhost").pathname;
  const relativeScript = basePath && scriptPath.startsWith(`${basePath}/`) ? scriptPath.slice(basePath.length) : scriptPath;
  const source = await readFile(path.join(output, relativeScript.replace(/^\/+/, "")), "utf8");
  if (source.includes(marker)) throw new Error(`Engine code was included in an initial page chunk: ${script}`);
}
console.log(`Static export is server-free; dynamic engine chunk ${(engineChunks[0].size / 1024).toFixed(1)} KiB / ${budget / 1024} KiB budget.`);
