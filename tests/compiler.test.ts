import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileYangModules, parseYang, resolveModuleSet, YangModule } from "../src/index.js";

function fixture(path: string): YangModule {
  return parseYang(readFileSync(fileURLToPath(new URL(`./fixtures/yang/${path}`, import.meta.url)), "utf8"));
}

function findNode(nodes: readonly { name: string; children: any[] }[], name: string): any {
  for (const node of nodes) {
    if (node.name === name) return node;
    const found = findNode(node.children, name);
    if (found) return found;
  }
  return undefined;
}

describe("semantic compilation foundation", () => {
  it("compiles oven data and RPC schema nodes with source-linked type statements", () => {
    const module = fixture("sysrepo/oven.yang");
    return resolveModuleSet([module], { async loadModule() { return undefined; } }).then(moduleSet => {
      const schema = compileYangModules(moduleSet);
      const temp = findNode(schema.roots, "temperature");
      expect(temp).toMatchObject({
        kind: "leaf", module: "oven", config: true, type: { argument: "oven-temperature" },
        resolvedType: "uint8", typedefChain: [{ argument: "oven-temperature" }],
      });
    expect(schema.operations.map(item => item.name)).toEqual(["insert-food", "remove-food", "oven-ready"]);
    expect(schema.operations[2]?.kind).toBe("notification");
      expect(schema.operations[0]?.input[0]).toMatchObject({ name: "time", kind: "leaf", module: "oven" });
      expect(schema.diagnostics).toEqual([]);
    });
  });

  it("resolves groupings and applies RFC 8344 and interface extension augments", async () => {
    const names = [
      "standard/ietf/RFC/ietf-interfaces@2018-02-20.yang",
      "standard/ietf/RFC/ietf-ip@2018-02-22.yang",
      "standard/ietf/RFC/ietf-inet-types@2013-07-15.yang",
      "standard/ietf/RFC/ietf-yang-types@2013-07-15.yang",
      "standard/ietf/draft/ietf-if-extensions@2025-08-07.yang",
      "standard/ietf/draft/ietf-if-ethernet-like@2025-08-07.yang",
      "standard/iana/iana-if-type@2023-01-26.yang",
    ];
    const roots = names.map(fixture);
    const byName = new Map(roots.map(module => [module.argument, module]));
    const moduleSet = await resolveModuleSet(roots, { async loadModule(name) { return byName.get(name); } });
    const schema = compileYangModules(moduleSet);
    expect(schema.diagnostics).toEqual([]);
    const interfaceList = findNode(schema.roots, "interface");
    expect(interfaceList?.kind).toBe("list");
    expect(interfaceList?.children.map((node: any) => node.name)).toContain("ipv4");
    expect(interfaceList?.children.map((node: any) => node.name)).toContain("ethernet-like");
    const statistics = findNode(interfaceList?.children ?? [], "statistics");
    expect(statistics?.children.some((node: any) => node.name === "in-pkts-64-octets")).toBe(true);
  });

  it("filters if-feature expressions when the caller supplies enabled features", async () => {
    const interfaces = fixture("standard/ietf/RFC/ietf-interfaces@2018-02-20.yang");
    const types = fixture("standard/ietf/RFC/ietf-yang-types@2013-07-15.yang");
    const moduleSet = await resolveModuleSet([interfaces, types], { async loadModule(name) { return name === "ietf-yang-types" ? types : undefined; } });
    const disabled = compileYangModules(moduleSet, { enabledFeatures: new Set() });
    const enabled = compileYangModules(moduleSet, { enabledFeatures: new Set(["ietf-interfaces:if-mib"]) });
    expect(findNode(disabled.roots, "admin-status")).toBeUndefined();
    expect(findNode(enabled.roots, "admin-status")).toMatchObject({
      featureRequirements: [{ module: "ietf-interfaces", expression: "if-mib" }],
    });
    expect(disabled.diagnostics).toEqual([]);
    expect(enabled.diagnostics).toEqual([]);
  });
});
