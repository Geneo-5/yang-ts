import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { buildAccessibleTree, compileYangModules, createConstraintEvaluator, parseYang, resolveModuleSet } from "../src/index.js";
import { parseXml } from "./dom.js";

const fixtures = new URL("./fixtures/yang/", import.meta.url);
function load(path: string) {
  return parseYang(readFileSync(fileURLToPath(new URL(path, fixtures)), "utf8"));
}

const IF_NS = "urn:ietf:params:xml:ns:yang:ietf-interfaces";
const EXT_NS = "urn:ietf:params:xml:ns:yang:ietf-if-extensions";

async function compiledFixtureSchema() {
  const modules = [
    load("standard/ietf/RFC/ietf-interfaces@2018-02-20.yang"),
    load("standard/ietf/RFC/ietf-yang-types@2013-07-15.yang"),
    load("standard/ietf/RFC/ietf-inet-types@2013-07-15.yang"),
    load("standard/iana/iana-if-type@2023-01-26.yang"),
    load("standard/ietf/draft/ietf-if-extensions@2025-08-07.yang"),
  ];
  const byName = new Map(modules.map(module => [module.argument, module]));
  return compileYangModules(await resolveModuleSet(modules, { async loadModule(name) { return byName.get(name); } }));
}

function interfaceDocument(type: string, extras: Array<[string, string]>): Document {
  const extrasText = extras.map(([name, value]) => `<${name} xmlns="${EXT_NS}">${value ?? ""}</${name}>`).join("");
  return parseXml(
    `<interfaces xmlns="${IF_NS}"><interface><name>veth0</name><type>${type}</type>${extrasText}</interface></interfaces>`,
  );
}

describe("fixture when/must constraints over accessible trees", () => {
  it("evaluates ietf-if-extensions when conditions over if:type values", async () => {
    const schema = await compiledFixtureSchema();
    const evaluator = createConstraintEvaluator(schema);
    const stateOf = (type: string, extras: Array<[string, string?]> = [["encapsulation"], ["loopback"]]) => {
      const tree = buildAccessibleTree(schema, interfaceDocument(type, extras as Array<[string, string]>), { context: "datastore-state" });
      const interfaceElement = Array.from(tree.document.getElementsByTagName("interface"))[0]!;
      const byName = (name: string) => Array.from(interfaceElement.getElementsByTagName(name))[0]!;
      return { tree, interfaceElement, byName };
    };

    // ethernetCsmacd: the encapsulation and loopback whens hold; the
    // sub-interface augment (parent-interface, gated by an augment-level when
    // evaluating at the interface) only exists for sub-interface types.
    const ethernet = stateOf("iana-if-type:ethernetCsmacd");
    expect(evaluator.evaluateNode(ethernet.byName("encapsulation")).find(item => item.kind === "when")?.status).toBe("met");
    expect(evaluator.evaluateNode(ethernet.byName("loopback")).find(item => item.kind === "when")?.status).toBe("met");

    // l2vlan: sub-interface augments become active; loopback no longer applies.
    const vlan = stateOf("iana-if-type:l2vlan", [["encapsulation"], ["loopback"], ["parent-interface", "veth0"]]);
    expect(evaluator.evaluateNode(vlan.byName("encapsulation")).find(item => item.kind === "when")?.status).toBe("met");
    expect(evaluator.evaluateNode(vlan.byName("loopback")).find(item => item.kind === "when")?.status).toBe("unmet");
    expect(evaluator.evaluateNode(vlan.byName("parent-interface")).find(item => item.kind === "when")?.status).toBe("met");
  });

  it("evaluates must constraints and reports failures as unmet or indeterminate", async () => {
    const schema = compileYangModules(await resolveModuleSet([
      parseYang(`module pool-must {
        namespace "urn:pool-must"; prefix p;
        container pool {
          must "count(node) >= 1";
          must "count(node) <= 3";
          leaf chosen { type leafref { path "../node/name"; } }
          list node { key name; leaf name { type string; } }
        }
      }`),
    ], { async loadModule() { return undefined; } }));
    const evaluator = createConstraintEvaluator(schema);
    const instance = (nodes: string) => parseXml(`<pool xmlns="urn:pool-must">${nodes}</pool>`);
    const poolElement = (nodes: string) =>
      buildAccessibleTree(schema, instance(nodes), { context: "datastore-state" }).document.getElementsByTagName("pool")[0]!;

    const met = evaluator.evaluateNode(poolElement("<node><name>a</name></node>"));
    expect(met.map(item => item.status)).toEqual(["met", "met"]);
    const unmet = evaluator.evaluateNode(poolElement(""));
    expect(unmet.map(item => item.status)).toEqual(["unmet", "met"]);
    // A node outside the effective schema has no constraints to report.
    expect(evaluator.evaluateNode(parseXml("<x/>").documentElement!)).toEqual([]);
  });
});
