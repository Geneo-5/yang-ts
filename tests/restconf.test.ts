import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createFormModel, createRestconfAddRequest, createRestconfDeleteRequest, createRestconfGetRequest,
  createRestconfDatastoreRequest, createRestconfNmdaProbeRequest, createRestconfRpcRequest,
  createRestconfSetRequest, createRestconfUpdateRequest, nodeToRestconfDataPath,
  nodeToRestconfDatastorePath, nodeToXPath, parseYang, readRestconfData, readRestconfRpcOutput, restconfRpcPath,
} from "../src/index.js";

const oven = parseYang(readFileSync(fileURLToPath(new URL("./fixtures/yang/sysrepo/oven.yang", import.meta.url)), "utf8"));

describe("RPC form and RESTCONF helpers", () => {
  it("exposes RPC input/output form fields and builds RFC 8040 request resources", () => {
    const form = createFormModel(oven);
    const insert = form.operations.find(operation => operation.name === "insert-food")!;
    const remove = form.operations.find(operation => operation.name === "remove-food")!;
    expect(insert.hasInput).toBe(true);
    expect(insert.hasOutput).toBe(false);
    expect(insert.inputFields.map(field => field.path)).toEqual(["/insert-food/input/time"]);
    expect(insert.inputFields[0]?.options.map(option => option.value)).toEqual(["now", "on-oven-ready"]);
    expect(restconfRpcPath(insert)).toBe("/restconf/operations/oven:insert-food");
    expect(createRestconfRpcRequest(insert, { time: "now" })).toMatchObject({
      method: "POST", path: "/restconf/operations/oven:insert-food",
      body: { "oven:input": { time: "now" } },
    });
    const queriedRpc = createRestconfRpcRequest(insert, { time: "now" }, "/restconf", { "with-defaults": "report-all" });
    expect(queriedRpc.path).toBe("/restconf/operations/oven:insert-food?with-defaults=report-all");
    expect(remove.hasInput).toBe(false);
    expect(createRestconfRpcRequest(remove)).not.toHaveProperty("body");
    expect(() => createRestconfRpcRequest(remove, {})).toThrow(/has no input/);
  });

  it("uses RFC 8040 JSON wrappers for RPC outputs", () => {
    const module = parseYang(`module ops { namespace "urn:ops"; prefix o; rpc status { output { leaf state { type string; } } } }`);
    const operation = createFormModel(module).operations[0]!;
    expect(operation.outputFields.map(field => field.path)).toEqual(["/status/output/state"]);
    expect(readRestconfRpcOutput(operation, { "ops:output": { state: "ready" } })).toEqual({ state: "ready" });
    expect(readRestconfRpcOutput(operation, { "wrong:output": { state: "ready" } })).toBeUndefined();
  });

  it("converts schema paths to XPath with context prefixes and escaped literals", () => {
    const context = parseYang(`module app { namespace "urn:app"; prefix a; import ietf-interfaces { prefix if; } import ietf-ip { prefix ip; } }`);
    expect(nodeToXPath(context, [
      { module: "ietf-interfaces", name: "interfaces" },
      { module: "ietf-interfaces", name: "interface", keys: [{ name: "name", value: "eth0" }] },
      { module: "ietf-ip", name: "ipv4" },
    ])).toBe("/if:interfaces/if:interface[if:name='eth0']/ip:ipv4");
    expect(nodeToXPath(context, [{ module: "app", name: "value", keys: [{ name: "id", value: `a'b\"c` }] }]))
      .toBe(`/a:value[a:id=concat('a',\"'\",'b\"c')]`);
    expect(() => nodeToXPath(context, [{ module: "missing", name: "node" }])).toThrow(/not imported/);
  });

  it("converts data-node paths to RESTCONF URI paths with ordered list keys", () => {
    expect(nodeToRestconfDataPath([
      { module: "ietf-interfaces", name: "interfaces" },
      { module: "ietf-interfaces", name: "interface", keys: [{ name: "name", value: "eth/0, west" }] },
      { module: "ietf-ip", name: "ipv4" },
    ], "/api/restconf/")).toBe("/api/restconf/data/ietf-interfaces:interfaces/interface=eth%2F0%2C%20west/ietf-ip:ipv4");
    expect(nodeToRestconfDataPath([
      { module: "m", name: "items", keys: [{ name: "a", value: "1" }, { name: "b", value: "2" }] },
    ])).toBe("/restconf/data/m:items=1,2");
  });

  it("prepares RESTCONF GET, POST create, PUT replace, PATCH merge and DELETE requests", () => {
    const interfaces = [{ module: "ietf-interfaces", name: "interfaces" }];
    const instance = [...interfaces, { module: "ietf-interfaces", name: "interface", keys: [{ name: "name", value: "eth0" }] }];
    const data = { name: "eth0", enabled: true };
    expect(createRestconfGetRequest(instance)).toEqual({
      method: "GET", path: "/restconf/data/ietf-interfaces:interfaces/interface=eth0",
      headers: { Accept: "application/yang-data+json" },
    });
    const queriedGet = createRestconfGetRequest(interfaces, "/restconf", {
      content: "config", depth: 2, fields: "interface(name,enabled)",
      filter: "/ietf-interfaces:interfaces/interface[name='eth 0']",
    });
    const getUrl = new URL(queriedGet.path, "https://device.example");
    expect(getUrl.pathname).toBe("/restconf/data/ietf-interfaces:interfaces");
    expect(getUrl.searchParams.get("content")).toBe("config");
    expect(getUrl.searchParams.get("depth")).toBe("2");
    expect(getUrl.searchParams.get("fields")).toBe("interface(name,enabled)");
    expect(getUrl.searchParams.get("filter")).toBe("/ietf-interfaces:interfaces/interface[name='eth 0']");
    expect(createRestconfAddRequest(interfaces, { module: "ietf-interfaces", name: "interface", data })).toMatchObject({
      method: "POST", path: "/restconf/data/ietf-interfaces:interfaces",
      body: { "ietf-interfaces:interface": data },
      headers: { "Content-Type": "application/yang-data+json" },
    });
    expect(createRestconfSetRequest(instance, { module: "ietf-interfaces", name: "interface", data })).toMatchObject({
      method: "PUT", path: "/restconf/data/ietf-interfaces:interfaces/interface=eth0",
      body: { "ietf-interfaces:interface": data },
    });
    expect(createRestconfUpdateRequest(instance, { module: "ietf-interfaces", name: "interface", data: { enabled: false } })).toMatchObject({
      method: "PATCH", path: "/restconf/data/ietf-interfaces:interfaces/interface=eth0",
      body: { "ietf-interfaces:interface": { enabled: false } },
    });
    expect(createRestconfUpdateRequest(instance, { module: "ietf-interfaces", name: "interface", data: { enabled: false } }, "/restconf", { test: "one & two" }).path)
      .toBe("/restconf/data/ietf-interfaces:interfaces/interface=eth0?test=one%20%26%20two");
    expect(createRestconfDeleteRequest(instance)).toEqual({
      method: "DELETE", path: "/restconf/data/ietf-interfaces:interfaces/interface=eth0",
      headers: { Accept: "application/yang-data+json" },
    });
    expect(readRestconfData({ "ietf-interfaces:interface": data }, "ietf-interfaces", "interface")).toEqual(data);
    expect(readRestconfData({ "ietf-interfaces:interface": data }, "ietf-interfaces", "missing")).toBeUndefined();
    expect(() => createRestconfDeleteRequest([])).toThrow(/requires a target/);
    expect(() => createRestconfSetRequest([], { module: "m", name: "n", data: {} })).toThrow(/requires a target/);
    expect(() => createRestconfUpdateRequest([], { module: "m", name: "n", data: {} })).toThrow(/requires a target/);
  });

  it("supports RFC 8527 datastore resources, with-origin and NMDA probing", () => {
    const path = [{ module: "ietf-interfaces", name: "interfaces" }];
    expect(nodeToRestconfDatastorePath("ietf-datastores:operational")).toBe("/restconf/ds/ietf-datastores:operational");
    expect(nodeToRestconfDatastorePath("ietf-datastores:running", path)).toBe("/restconf/ds/ietf-datastores:running/ietf-interfaces:interfaces");
    expect(nodeToRestconfDatastorePath("ietf-datastores:intended", path, "/api/restconf/")).toBe("/api/restconf/ds/ietf-datastores:intended/ietf-interfaces:interfaces");
    expect(createRestconfNmdaProbeRequest()).toMatchObject({
      method: "HEAD", path: "/restconf/ds/ietf-datastores:operational",
    });
    expect(createRestconfDatastoreRequest("GET", "ietf-datastores:operational", path, undefined, { "with-origin": true }))
      .toMatchObject({ method: "GET", path: "/restconf/ds/ietf-datastores:operational/ietf-interfaces:interfaces?with-origin" });
    expect(createRestconfDatastoreRequest("PUT", "ietf-datastores:running", path, {
      module: "ietf-interfaces", name: "interfaces", data: { interface: [] },
    })).toMatchObject({
      method: "PUT", path: "/restconf/ds/ietf-datastores:running/ietf-interfaces:interfaces",
      body: { "ietf-interfaces:interfaces": { interface: [] } },
    });
    expect(() => createRestconfDatastoreRequest("GET", "ietf-datastores:running", [], undefined, { "with-origin": true }))
      .toThrow(/requires the operational datastore/);
    expect(() => nodeToRestconfDatastorePath("operational")).toThrow(/module-qualified/);
  });
});
