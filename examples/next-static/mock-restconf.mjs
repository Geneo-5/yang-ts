// Mock RESTCONF server that serves all YANG fixtures from tests/fixtures/yang/
// for local development and browser testing.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, pathToFileURL } from "node:url";

const jsonType = "application/yang-data+json";
const fixturesRoot = resolve(import.meta.dirname + "/", "../../tests/fixtures/yang");

function restconfError(tag, message) {
  return {
    "ietf-restconf:errors": {
      error: [{ "error-type": "protocol", "error-tag": tag, "error-message": message }],
    },
  };
}

// Load all fixture modules into memory
const fixtureModules = new Map();

function loadFixtureModules() {
  const files = [
    "sysrepo/oven.yang",
    "standard/ietf/RFC/ietf-yang-types@2013-07-15.yang",
    "standard/ietf/RFC/ietf-inet-types@2013-07-15.yang",
    "standard/ietf/RFC/ietf-interfaces@2018-02-20.yang",
    "standard/ietf/RFC/ietf-ip@2018-02-22.yang",
    "standard/iana/iana-if-type@2023-01-26.yang",
    "standard/ietf/draft/ietf-if-ethernet-like@2025-08-07.yang",
    "standard/ietf/draft/ietf-if-extensions@2025-08-07.yang",
  ];
  for (const relPath of files) {
    try {
      const filePath = resolve(resolve(fixturesRoot, "") + "/", relPath);
      const source = readFileSync(filePath, "utf8");
      const nameMatch = source.match(/^module\s+(\S+)/);
      const name = nameMatch ? nameMatch[1] : relPath.split("/").pop()?.split("@")[0] ?? "";
      fixtureModules.set(name, source);
    } catch {
      // Skip missing files silently
    }
  }
}

loadFixtureModules();

/** Start a small in-memory RESTCONF endpoint for local examples and browser tests. */
export function createMockRestconfServer({
  data = { "example-device:system": { hostname: "router-1", enabled: true } },
  modules = {},
  cors = true,
} = {}) {
  const resources = new Map(Object.entries(data).map(([path, value]) => [path, structuredClone(value)]));
  let revision = 1;
  const serverModules = new Map([...fixtureModules, ...Object.entries(modules)]);

  // Build the YANG Library inventory from embedded modules
  function buildYangLibrary(reqHost) {
    const moduleRows = [];
    for (const [name, source] of serverModules) {
      // Extract namespace and prefix from module text
      const nsMatch = source.match(/namespace\s+"([^"]+)"/);
      const prefMatch = source.match(/prefix\s+"?([a-z][a-z0-9-]*)"?/i);
      const revMatch = source.match(/revision\s+(\d{4}-\d{2}-\d{2})/);
      moduleRows.push({
        name,
        revision: revMatch ? revMatch[1] : "2026-01-01",
        namespace: nsMatch ? nsMatch[1] : `urn:example:${name}`,
        "conformance-type": "implement",
        location: `http://${reqHost}/yang?module=${encodeURIComponent(name)}`,
      });
    }
    return { "ietf-yang-library:yang-library": { "content-id": "mock-1", "module-set": [{ name: "mock", module: moduleRows }] } };
  }

  const server = createServer(async (request, response) => {
    const headers = { "Content-Type": jsonType, "Cache-Control": "no-store" };
    if (cors) {
      headers["Access-Control-Allow-Origin"] = request.headers.origin ?? "*";
      headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Accept, Content-Type, If-Match";
      headers["Access-Control-Expose-Headers"] = "ETag, Location";
    }
    const send = (status, body, extra = {}) => {
      response.writeHead(status, { ...headers, ...extra });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (request.method === "OPTIONS") return send(204);

    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.headers["x-mock-error"] === "true") {
      return send(409, restconfError("in-use", "Requested mock conflict"));
    }
    if (url.pathname === "/restconf/data/ietf-yang-library:yang-library" && request.method === "GET") {
      return send(200, buildYangLibrary(request.headers.host ?? "localhost"), { ETag: `"${revision}"` });
    }
    if (url.pathname === "/yang" && request.method === "GET") {
      const moduleName = url.searchParams.get("module") ?? "";
      const source = serverModules.get(moduleName);
      if (typeof source !== "string") return send(404, restconfError("data-missing", "YANG module not found"));
      response.writeHead(200, { ...headers, "Content-Type": "application/yang" });
      return response.end(source);
    }
    if (url.pathname.startsWith("/restconf/operations/") && request.method === "POST") {
      return send(200, { output: {} }, { ETag: `"${revision}"` });
    }

    const key = decodeURIComponent(url.pathname.replace(/^\/restconf\/data\/?/, ""));
    if (!key || key === url.pathname) return send(404, restconfError("invalid-value", "Unknown RESTCONF path"));
    if (request.method === "GET") {
      if (!resources.has(key)) return send(404, restconfError("data-missing", "Resource not found"));
      return send(200, { [key]: structuredClone(resources.get(key)) }, { ETag: `"${revision}"` });
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "")) {
      if (request.headers["if-match"] && request.headers["if-match"] !== `"${revision}"`) {
        return send(412, restconfError("precondition-failed", "ETag does not match"), { ETag: `"${revision}"` });
      }
      if (request.method === "DELETE") {
        if (!resources.delete(key)) return send(404, restconfError("data-missing", "Resource not found"));
        revision++;
        return send(204);
      }
      let body;
      try {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return send(400, restconfError("malformed-message", "Request body must be JSON"));
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return send(400, restconfError("invalid-value", "Request body must be an object"));
      }
      if (request.method === "POST" && resources.has(key)) return send(409, restconfError("data-exists", "Resource already exists"));
      if (request.method === "PATCH" && !resources.has(key)) return send(404, restconfError("data-missing", "Resource not found"));
      const resourceName = key.split("/").at(-1)?.split("=")[0];
      const unwrapped = resourceName && body[resourceName] && typeof body[resourceName] === "object"
        ? body[resourceName]
        : body;
      const value = request.method === "PATCH" ? { ...resources.get(key), ...unwrapped } : unwrapped;
      resources.set(key, structuredClone(value));
      revision++;
      return send(request.method === "POST" ? 201 : 200, { [key]: value }, { ETag: `"${revision}"`, ...(request.method === "POST" ? { Location: `${url.pathname}` } : {}) });
    }
    return send(405, restconfError("operation-not-supported", "Method not supported"), { Allow: "GET, POST, PUT, PATCH, DELETE, OPTIONS" });
  });

  return {
    server,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address();
          if (!address || typeof address === "string") return reject(new Error("Mock server did not bind a TCP port"));
          resolve(`http://${host}:${address.port}`);
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

if (process.argv[1] && import.meta.url.includes("mock-restconf.mjs")) {
  const mock = createMockRestconfServer({ cors: process.env.MOCK_CORS !== "false" });
  const url = await mock.listen(Number(process.env.PORT ?? 8081), process.env.HOST ?? "127.0.0.1");
  console.log(`Mock RESTCONF server listening at ${url}`);
  console.log(`Serving ${fixtureModules.size} YANG modules: ${[...fixtureModules.keys()].join(", ")}`);
}
