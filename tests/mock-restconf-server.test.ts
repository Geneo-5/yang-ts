import { afterEach, describe, expect, it } from "vitest";

const running: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map(server => server.close()));
});

describe("Stage 8.6 mock RESTCONF server", () => {
  it("supports reads, creates, merges, deletes, ETags and typed RESTCONF errors", async () => {
    const { createMockRestconfServer } = await import("../examples/next-static/mock-restconf.mjs");
    const mock = createMockRestconfServer({ data: { "example-device:system": { hostname: "router-1", enabled: true } } });
    const base = await mock.listen();
    running.push(mock);
    const path = "/restconf/data/example-device:system";

    const read = await fetch(base + path);
    expect(read.status).toBe(200);
    expect(read.headers.get("etag")).toBe('"1"');
    expect(await read.json()).toEqual({ "example-device:system": { hostname: "router-1", enabled: true } });

    const stale = await fetch(base + path, { method: "PATCH", headers: { "Content-Type": "application/yang-data+json", "If-Match": '"0"' }, body: JSON.stringify({ enabled: false }) });
    expect(stale.status).toBe(412);
    expect((await stale.json())["ietf-restconf:errors"].error[0]["error-tag"]).toBe("precondition-failed");

    const update = await fetch(base + path, { method: "PATCH", headers: { "Content-Type": "application/yang-data+json", "If-Match": read.headers.get("etag")! }, body: JSON.stringify({ enabled: false }) });
    expect(update.status).toBe(200);
    expect(await update.json()).toEqual({ "example-device:system": { hostname: "router-1", enabled: false } });

    const replace = await fetch(base + path, { method: "PUT", headers: { "Content-Type": "application/yang-data+json" }, body: JSON.stringify({ hostname: "router-2" }) });
    expect(replace.status).toBe(200);
    expect(await replace.json()).toEqual({ "example-device:system": { hostname: "router-2" } });

    const created = await fetch(base + "/restconf/data/example-device:system/ntp", { method: "POST", headers: { "Content-Type": "application/yang-data+json" }, body: JSON.stringify({ server: "192.0.2.1" }) });
    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toContain("/ntp");
    expect((await fetch(base + "/restconf/data/example-device:system/ntp", { method: "DELETE" })).status).toBe(204);

    const forced = await fetch(base + path, { headers: { "X-Mock-Error": "true" } });
    expect(forced.status).toBe(409);
    expect(forced.headers.get("access-control-allow-origin")).toBe("*");
    const source = await fetch(base + "/yang?module=oven", { headers: { Origin: "http://console.example" } });
    expect(source.headers.get("access-control-allow-origin")).toBe("http://console.example");
    expect(await source.text()).toContain("module oven");
  });

  it("can disable CORS and serves a YANG Library inventory", async () => {
    const { createMockRestconfServer } = await import("../examples/next-static/mock-restconf.mjs");
    const mock = createMockRestconfServer({ cors: false });
    const base = await mock.listen();
    running.push(mock);
    const inventory = await fetch(base + "/restconf/data/ietf-yang-library:yang-library");
    expect(inventory.status).toBe(200);
    expect(inventory.headers.get("access-control-allow-origin")).toBeNull();
    expect(await inventory.json()).toHaveProperty("ietf-yang-library:yang-library.module-set");
    const module = await fetch(base + "/yang?module=oven");
    expect(module.status).toBe(200);
    expect(module.headers.get("content-type")).toBe("application/yang");
    expect(await module.text()).toContain("module oven");
  });
});
