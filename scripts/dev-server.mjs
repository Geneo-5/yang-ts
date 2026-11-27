// Starts both the mock RESTCONF server and a static file server for the
// Next.js static-export example, then opens the page in the default browser.

import { createServer as createHttpServer } from "node:http";
import { stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { createMockRestconfServer } from "../examples/next-static/mock-restconf.mjs";

const root = resolve(import.meta.dirname, "../examples/next-static");
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

async function isPortInUse(port) {
  return new Promise((resolve) => {
    const s = createHttpServer();
    s.once("error", () => resolve(true));
    s.once("listening", () => { s.close(); resolve(false); });
    s.listen(port, "127.0.0.1");
  });
}

async function main() {
  // Start mock RESTCONF on port 8081 (use existing if already running).
  let mockUrl;
  if (await isPortInUse(8081)) {
    // Port already in use — assume user started the mock server manually.
    mockUrl = "http://127.0.0.1:8081";
    console.log("Using existing mock RESTCONF on port 8081.");
  } else {
    const mock = createMockRestconfServer({ cors: true });
    mockUrl = await mock.listen(8081);
    console.log(`Mock RESTCONF: ${mockUrl}`);
  }

  // Start static file server on a random available port.
  const staticServer = createHttpServer(async (request, response) => {
    try {
      const urlPath = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      const relative = urlPath.replace(/^\//, "");
      let target = resolve(root, relative || "index.html");
      if (!target.startsWith(root)) throw new Error("Invalid path");
      const st = await stat(target);
      if (st.isDirectory()) target = resolve(target, "index.html");
      response.writeHead(200, { "Content-Type": contentTypes[extname(target)] ?? "application/octet-stream" });
      const { createReadStream } = await import("node:fs");
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
  if (!address || typeof address !== "object") {
    console.error("Static server did not bind a port");
    process.exit(1);
  }

  const staticUrl = `http://127.0.0.1:${address.port}`;
  console.log(`Static files:  ${staticUrl}`);
  console.log(`Open your browser at: ${staticUrl}`);
  console.log("\nThe app will connect to the mock RESTCONF at http://127.0.0.1:8081/restconf");
  console.log("(Press Ctrl+C to stop both servers)");
}

main().catch(err => { console.error(err); process.exit(1); });
