import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileYangModules, isIdentityDerivedFrom, parseYang, resolveModuleSet, YangModule } from "../src/index.js";

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
  it("materializes implicit cases in choices and choice augments", async () => {
    const base = parseYang(`module base {
      namespace "urn:base"; prefix b;
      container settings {
        choice transport {
          leaf tcp { type uint16; }
          container udp { leaf port { type uint16; } }
          case local { leaf unix { type string; } }
        }
      }
    }`);
    const extension = parseYang(`module extension {
      namespace "urn:extension"; prefix e; import base { prefix b; }
      augment /b:settings/b:transport { leaf quic { type boolean; } }
    }`);
    const moduleSet = await resolveModuleSet([base, extension], { async loadModule() { return undefined; } });
    const schema = compileYangModules(moduleSet);
    const choice = findNode(schema.roots, "transport");
    expect(choice.children.map((node: any) => [node.kind, node.name])).toEqual([
      ["case", "tcp"], ["case", "udp"], ["case", "local"], ["case", "quic"],
    ]);
    expect(choice.children[0]).toMatchObject({ path: "/settings/transport/tcp", children: [{ kind: "leaf", name: "tcp", path: "/settings/transport/tcp/tcp" }] });
    expect(choice.children[1].children[0]).toMatchObject({ kind: "container", name: "udp", children: [{ name: "port" }] });
    expect(schema.diagnostics).toEqual([]);
  });

  it("compiles RPC and notification declarations from included submodules", async () => {
    const module = parseYang(`module operations { namespace "urn:operations"; prefix o; include operations-extra; }`);
    const moduleSet = await resolveModuleSet([module], {
      async loadModule() { return undefined; },
      async loadSubmodule(name) {
        return name === "operations-extra" ? `submodule operations-extra {
          belongs-to operations { prefix o; }
          rpc reset { input { leaf mode { type string; } } output { leaf done { type boolean; } } }
          notification changed { leaf id { type string; } }
        }` : undefined;
      },
    });
    const schema = compileYangModules(moduleSet);
    expect(schema.operations.map(operation => [operation.kind, operation.name])).toEqual([
      ["rpc", "reset"], ["notification", "changed"],
    ]);
    expect(schema.operations[0]?.input[0]).toMatchObject({ path: "/reset/input/mode", module: "operations" });
    expect(schema.diagnostics).toEqual([]);
  });

  it("validates list keys against effective children introduced by uses", async () => {
    const module = parseYang(`module keyed {
      namespace "urn:keyed"; prefix k;
      grouping record-key { leaf id { type string; } }
      container root {
        list records { key "id"; uses record-key; leaf value { type string; } }
        list invalid { key "id"; leaf id { type string; config false; } }
      }
    }`);
    const moduleSet = await resolveModuleSet([module], { async loadModule() { return undefined; } });
    const schema = compileYangModules(moduleSet);
    expect(schema.diagnostics.filter(diagnostic => diagnostic.code === "invalid-key")).toHaveLength(1);
    expect(schema.diagnostics.find(diagnostic => diagnostic.code === "invalid-key")?.message).toContain("same config value");
  });

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

  it("applies RFC 7950 deviations to nodes and properties", async () => {
    const base = parseYang(`module base {
      namespace "urn:base"; prefix b;
      container system {
        leaf daylight { type string; }
        leaf count { type uint8; default "1"; }
        leaf note { type string; must ". != ''"; }
        list users { key "name"; leaf name { type string; } }
      }
    }`);
    const deviations = parseYang(`module device-deviations {
      namespace "urn:device"; prefix d;
      import base { prefix b; }
      deviation /b:system/b:daylight { deviate not-supported; }
      deviation /b:system/b:count { deviate replace { type uint16; default "2"; } }
      deviation /b:system/b:note { deviate delete { must ". != ''"; } }
      deviation /b:system/b:users { deviate add { max-elements 10; must "count(.) <= 10"; } }
    }`);
    const moduleSet = await resolveModuleSet([base, deviations], { async loadModule() { return undefined; } });
    const schema = compileYangModules(moduleSet);
    const system = findNode(schema.roots, "system");
    expect(findNode(system.children, "daylight")).toBeUndefined();
    expect(findNode(system.children, "count")).toMatchObject({
      resolvedType: "uint16", properties: { default: [{ argument: "2" }] },
      deviations: [{ keyword: "deviation", argument: "/b:system/b:count" }],
    });
    expect(findNode(system.children, "note")?.must).toEqual([]);
    expect(findNode(system.children, "users")?.properties).toMatchObject({
      "max-elements": [{ argument: "10" }], must: [{ argument: "count(.) <= 10" }],
    });
    expect(schema.diagnostics).toEqual([]);
  });

  it("diagnoses unresolved deviation targets and invalid property operations", async () => {
    const base = parseYang(`module base { namespace "urn:base"; prefix b; leaf value { type string; } }`);
    const deviations = parseYang(`module bad-deviations {
      namespace "urn:bad"; prefix d; import base { prefix b; }
      deviation /b:missing { deviate not-supported; }
      deviation /b:value { deviate replace { units "widgets"; } deviate delete { default "x"; } }
    }`);
    const moduleSet = await resolveModuleSet([base, deviations], { async loadModule() { return undefined; } });
    const schema = compileYangModules(moduleSet);
    expect(schema.diagnostics.map(item => item.code)).toContain("unresolved-deviation");
    expect(schema.diagnostics.filter(item => item.code === "invalid-deviation")).toHaveLength(2);
  });

  it("applies uses refinements and binds imported grouping nodes to the use-site module", async () => {
    const library = parseYang(`module library {
      namespace "urn:library"; prefix l;
      typedef port-number { type uint16; }
      grouping endpoint {
        leaf port { type port-number; }
        container metadata { leaf tag { type string; } }
      }
    }`);
    const application = parseYang(`module application {
      namespace "urn:application"; prefix a;
      import library { prefix l; }
      container service {
        uses l:endpoint {
          refine port { default 443; description "TLS listener port"; }
          refine metadata { presence "metadata is explicitly configured"; }
        }
      }
    }`);
    const moduleSet = await resolveModuleSet([application], { async loadModule() { return library; } });
    const schema = compileYangModules(moduleSet);
    const service = findNode(schema.roots, "service");
    expect(findNode(service.children, "port")).toMatchObject({
      module: "application", namespace: "urn:application", resolvedType: "uint16",
      typedefChain: [{ argument: "port-number" }],
      properties: { default: [{ argument: "443" }], description: [{ argument: "TLS listener port" }] },
    });
    expect(findNode(service.children, "metadata")?.properties.presence?.[0]?.argument).toBe("metadata is explicitly configured");
    expect(schema.diagnostics).toEqual([]);
  });

  it("resolves transitive identity inheritance and detects identity cycles", async () => {
    const base = parseYang(`module base { namespace "urn:base"; prefix b; identity root; }`);
    const middle = parseYang(`module middle { namespace "urn:middle"; prefix m; import base { prefix b; } identity child { base b:root; } }`);
    const leaf = parseYang(`module leaf { namespace "urn:leaf"; prefix l; import middle { prefix m; } identity ethernet { base m:child; } }`);
    const moduleByName = new Map([base, middle].map(module => [module.argument, module]));
    const moduleSet = await resolveModuleSet([leaf], { async loadModule(name) { return moduleByName.get(name); } });
    const schema = compileYangModules(moduleSet);
    expect(isIdentityDerivedFrom(schema, "leaf:ethernet", "base:root")).toBe(true);
    expect(isIdentityDerivedFrom(schema, "middle:child", "base:root")).toBe(true);
    expect(isIdentityDerivedFrom(schema, "base:root", "base:root")).toBe(false);
    expect(schema.diagnostics).toEqual([]);

    const cycleA = parseYang(`module a { namespace "urn:a"; prefix a; import b { prefix b; } identity one { base b:two; } }`);
    const cycleB = parseYang(`module b { namespace "urn:b"; prefix b; import a { prefix a; } identity two { base a:one; } }`);
    const cycleSet = await resolveModuleSet([cycleA], { async loadModule(name) { return name === "b" ? cycleB : undefined; } });
    expect(compileYangModules(cycleSet).diagnostics.map(item => item.code)).toContain("identity-cycle");
  });

  it("resolves interface and IANA identities from the requested fixture modules", async () => {
    const roots = [
      fixture("standard/ietf/RFC/ietf-interfaces@2018-02-20.yang"),
      fixture("standard/ietf/RFC/ietf-yang-types@2013-07-15.yang"),
      fixture("standard/iana/iana-if-type@2023-01-26.yang"),
    ];
    const byName = new Map(roots.map(module => [module.argument, module]));
    const moduleSet = await resolveModuleSet(roots, { async loadModule(name) { return byName.get(name); } });
    const schema = compileYangModules(moduleSet);
    expect(isIdentityDerivedFrom(schema, "iana-if-type:ethernetCsmacd", "ietf-interfaces:interface-type")).toBe(true);
    expect(schema.diagnostics).toEqual([]);
  });
});
