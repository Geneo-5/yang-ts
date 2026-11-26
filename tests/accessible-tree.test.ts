import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { buildAccessibleTree, compileYangModules, parseYang, resolveModuleSet } from "../src/index.js";
import { compileYangXPath, createYangFunctionLibrary } from "../src/internal.js";
import { parseXml } from "./dom.js";

const schema = compileYangModules(await resolveModuleSet([
  parseYang(`module system {
    namespace "urn:system"; prefix s;
    container system {
      leaf hostname { type string; }
      leaf motd { type string; default "welcome"; }
      container state {
        config false;
        leaf uptime { type string; }
      }
      list interface { key name; leaf name { type string; } }
    }
    rpc reset { input { leaf force { type boolean; } } output { leaf done { type boolean; } } }
    notification changed { leaf id { type string; } }
  }`),
], { async loadModule() { return undefined; } }));

function datatree(instanceText: string): Document {
  return parseXml(instanceText);
}

const text = (document: Document, path: string): string => Array.from(document.getElementsByTagName(path)).map(node => node.textContent ?? "").join("|");

describe("RFC 7950 accessible tree construction", () => {
  it("injects datastore defaults elsewhere absent from the instance", () => {
    const tree = buildAccessibleTree(schema, datatree(
      `<system xmlns="urn:system"><hostname>router1</hostname></system>`), { context: "datastore-config" });
    expect(text(tree.document, "hostname")).toBe("router1");
    expect(text(tree.document, "motd")).toBe("welcome");
    // RFC 6.4.1: the datastore context node is the virtual root (the document),
    // with the data root as its single top-level child — no extra wrapper.
    expect(tree.contextNode).toBe(tree.document);
    expect(tree.document.documentElement.localName).toBe("system");
    // Relative paths evaluate at the data node (documentElement here);
    // absolute YANG paths treat the data root as the top-level node.
    expect(compileYangXPath("count(motd) = 1", "urn:system").evaluateBoolean({ node: tree.document.documentElement })).toBe(true);
    expect(compileYangXPath("/system:system/system:hostname = 'router1'", "urn:system", { system: "urn:system" })
      .evaluateBoolean({ node: tree.contextNode })).toBe(true);
  });

  it("keeps state data out of datastore-config and in datastore-state", () => {
    const instance = datatree(`<system xmlns="urn:system"><hostname>router1</hostname><state><uptime>99</uptime></state></system>`);
    const config = buildAccessibleTree(schema, instance, { context: "datastore-config" });
    const state = buildAccessibleTree(schema, instance, { context: "datastore-state" });
    expect(Array.from(state.document.getElementsByTagName("uptime"))).toHaveLength(1);
    expect(Array.from(config.document.getElementsByTagName("uptime"))).toHaveLength(0);
  });

  it("supports must expressions over the built datastore tree", () => {
    const tree = buildAccessibleTree(schema, datatree(
      `<system xmlns="urn:system"><hostname>router1</hostname><motd>welcome</motd></system>`), { context: "datastore-state" });
    const must = compileYangXPath("count(state) = 0 and count(interface) = 0", "urn:system");
    expect(must.evaluateBoolean({ node: tree.contextNode })).toBe(true);
    // config false subtrees are absent from the datastore-config accessible tree
    const configTree = buildAccessibleTree(schema, datatree(
      `<system xmlns="urn:system"><hostname>router1</hostname></system>`), { context: "datastore-config" });
    expect(compileYangXPath("count(state) = 0", "urn:system").evaluateBoolean({ node: configTree.contextNode })).toBe(true);
  });

  it("scopes RPC input and output into fictional operation trees", () => {
    const input = buildAccessibleTree(schema, datatree(
      `<reset xmlns="urn:system"><force>true</force></reset>`), { context: "rpc-input", operation: "system:reset" });
    expect((input.contextNode as Element).localName).toBe("reset");
    const mustForce = compileYangXPath("force", "urn:system");
    expect(mustForce.evaluateBoolean({ node: input.contextNode })).toBe(true);
    // Output leaves are not visible in the input scope.
    expect(compileYangXPath("count(done)", "urn:system").evaluateNumber({ node: input.contextNode })).toBe(0);

    const output = buildAccessibleTree(schema, datatree(
      `<reset xmlns="urn:system"><done>true</done></reset>`), { context: "rpc-output", operation: "reset" });
    expect(compileYangXPath("done", "urn:system").evaluateBoolean({ node: output.contextNode })).toBe(true);
    expect(compileYangXPath("count(force)", "urn:system").evaluateNumber({ node: output.contextNode })).toBe(0);
  });

  it("scopes notification content into a fictional notification tree", () => {
    const tree = buildAccessibleTree(schema, datatree(
      `<changed xmlns="urn:system"><id>42</id></changed>`), { context: "notification", operation: "changed" });
    expect(compileYangXPath("id = '42'", "urn:system").evaluateBoolean({ node: tree.contextNode })).toBe(true);
    expect((tree.contextNode as Element).localName).toBe("changed");
  });

  it("rejects operation contexts without compilable targets", () => {
    expect(() => buildAccessibleTree(schema, datatree(`<x/>`), { context: "rpc-input", operation: "missing" })).toThrow(/missing/);
    expect(() => buildAccessibleTree(schema, datatree(`<x/>`), { context: "rpc-input" })).toThrow(/requires an operation name/);
  });

  it("works with deref following leafref paths over the datastore tree", async () => {
    const refs = compileYangModules(await resolveModuleSet([
      parseYang(`module refs {
        namespace "urn:refs"; prefix r;
        container pool {
          leaf chosen { type leafref { path "../node/name"; } }
          list node { key name; leaf name { type string; } leaf value { type string; } }
        }
      }`),
    ], { async loadModule() { return undefined; } }));
    const tree = buildAccessibleTree(refs, datatree(`<pool xmlns="urn:refs">
      <chosen>n2</chosen>
      <node><name>n1</name><value>a</value></node>
      <node><name>n2</name><value>b</value></node>
    </pool>`), { context: "datastore-state" });
    const library = createYangFunctionLibrary({ schema: refs, module: "refs" });
    const evaluate = (expression: string) => compileYangXPath(expression, "urn:refs").evaluateBoolean({ node: tree.contextNode, functions: library });
    // deref(pool/chosen) yields the <name> leaf the leafref points at; the
    // value leaf of the referenced node accompanies it through the relative step.
    expect(evaluate("string(deref(pool/chosen)) = 'n2'")).toBe(true);
    expect(evaluate("string(deref(pool/chosen)/../value) = 'b'")).toBe(true);
    // Non-leafref arguments come back unchanged.
    expect(evaluate("count(deref(pool/node)) = 2")).toBe(true);
  });
});
