import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createFormModel, createRestconfRpcRequest, nodeToRestconfDataPath, nodeToXPath,
  parseYang, readRestconfRpcOutput, restconfRpcPath,
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
});
