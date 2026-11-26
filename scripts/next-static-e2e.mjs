import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createMockRestconfServer } from "../examples/next-static/mock-restconf.mjs";

const root = fileURLToPath(new URL("../examples/next-static/out/", import.meta.url));
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");
const contentTypes = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".txt": "text/plain",
  ".svg": "image/svg+xml", ".woff2": "font/woff2",
};
const mock = createMockRestconfServer();
let staticServer;
let browser;

try {
  await access(path.join(root, "index.html"));
  await mock.listen(8081);
  staticServer = createServer(async (request, response) => {
    try {
      let urlPath = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      if (basePath) {
        if (urlPath !== basePath && !urlPath.startsWith(`${basePath}/`)) throw new Error("Outside configured basePath");
        urlPath = urlPath.slice(basePath.length) || "/";
      }
      const relative = urlPath.replace(/^\/+/, "");
      let target = path.resolve(root, relative || "index.html");
      if (!target.startsWith(root)) throw new Error("Invalid path");
      if ((await stat(target)).isDirectory()) target = path.join(target, "index.html");
      response.writeHead(200, { "Content-Type": contentTypes[path.extname(target)] ?? "application/octet-stream" });
      createReadStream(target).pipe(response);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  await new Promise((resolve, reject) => {
    staticServer.once("error", reject);
    staticServer.listen(0, "127.0.0.1", resolve);
  });
  const address = staticServer.address();
  if (!address || typeof address === "string") throw new Error("Static host did not bind a port");
  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("requestfailed", request => consoleErrors.push(`${request.url()}: ${request.failure()?.errorText ?? "request failed"}`));
  await page.goto(`http://127.0.0.1:${address.port}${basePath}/`);
  await page.getByRole("button", { name: "Connect and load schema" }).click();
  await page.waitForFunction(() => {
    const status = document.querySelector('[role="status"]')?.textContent ?? "";
    return status.includes("Connected") || status.includes("failed");
  }, undefined, { timeout: 10000 });
  const connectionStatus = await page.getByRole("status").textContent();
  if (!connectionStatus?.includes("Connected")) {
    throw new Error(`Connection failed: ${connectionStatus}; ${await page.locator('[role="alert"]').allTextContents()}; browser errors: ${[...pageErrors, ...consoleErrors].join("; ")}`);
  }
  await page.getByRole("heading", { name: "Configuration" }).waitFor({ timeout: 5000 });

  const temperature = page.locator(".fields").getByRole("spinbutton");
  await temperature.fill("300");
  await page.getByRole("button", { name: "Validate and save with PATCH" }).click();
  await page.getByRole("alert").filter({ hasText: "range" }).waitFor();
  const unchanged = await (await fetch("http://127.0.0.1:8081/restconf/data/oven:oven", { headers: { Accept: "application/yang-data+json" } })).json();
  if (unchanged["oven:oven"]?.temperature !== 0) throw new Error("Invalid local value was sent to RESTCONF");

  await temperature.fill("215");
  await page.getByRole("button", { name: "Validate and save with PATCH" }).click();
  await page.getByRole("alert").filter({ hasText: "Configuration saved" }).waitFor();
  const saved = await (await fetch("http://127.0.0.1:8081/restconf/data/oven:oven", { headers: { Accept: "application/yang-data+json" } })).json();
  if (saved["oven:oven"]?.temperature !== 215) throw new Error("PATCH did not update mock RESTCONF data");

  await page.getByRole("heading", { name: "RPC operations" }).waitFor();
  await page.locator(".operation-list button").first().click();
  await page.getByRole("alert").filter({ hasText: "returned HTTP 200" }).waitFor();
  if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join("; ")}`);
  console.log("Next.js static export passed browser discovery, validation, PATCH and RPC checks.");
} finally {
  await browser?.close();
  if (staticServer?.listening) await new Promise(resolve => staticServer.close(resolve));
  if (mock.server.listening) await mock.close();
}
