import { describe, expect, it } from "vitest";
import { compileYangModules, parseYang, resolveModuleSet } from "../src/index.js";

const compile = async (text: string, options?: Parameters<typeof compileYangModules>[1]) =>
  compileYangModules(await resolveModuleSet([parseYang(text)], { async loadModule() { return undefined; } }), options);

const compileAll = async (...texts: string[]) =>
  compileYangModules(await resolveModuleSet(texts.map(text => parseYang(text)), { async loadModule() { return undefined; } }));

/** Stage 7b P1 (ROADMAP §150): feature-to-feature dependencies (RFC 7950 §7.20.2). */
describe("feature-to-feature dependencies", () => {
  const module = `module features {
    namespace "urn:features"; prefix f;
    feature advanced { if-feature extras; }
    feature extras;
    container box {
      if-feature advanced;
      leaf deep { type string; }
      leaf plain { type string; }
    }
  }`;

  it("disables a feature whose own if-feature is not enabled", async () => {
    const schema = await compile(module, { enabledFeatures: new Set(["features:advanced"]) });
    // `advanced` requires `extras`; without `extras` the container's node is
    // filtered. Pre-fix only the feature's existence was checked.
    expect(schema.diagnostics.map(item => item.code)).toEqual([]);
    expect(schema.roots.find(root => root.name === "box")).toBeUndefined();
  });

  it("keeps a feature enabled when its whole if-feature chain is enabled", async () => {
    const schema = await compile(module, { enabledFeatures: new Set(["features:advanced", "features:extras"]) });
    expect(schema.roots.find(root => root.name === "box")).toBeDefined();
  });
});

/** Stage 7b P1 (ROADMAP §151): deviations targeting operation parameter nodes (RFC 7950 §7.20.3). */
describe("deviations on operation parameter nodes", () => {
  it("applies deviations to RPC input parameters", async () => {
    const schema = await compile(`module rpcdev {
      namespace "urn:rpcdev"; prefix r;
      rpc activate {
        input { leaf timeout { type uint16; } }
      }
      deviation "/r:activate/r:input/r:timeout" { deviate add { default "30"; } }
    }`);
    expect(schema.diagnostics.map(item => item.code)).toEqual([]);
    const activate = schema.operations.find(operation => operation.name === "activate")!;
    expect(activate.input.find(node => node.name === "timeout")!.properties.default?.[0]?.argument).toBe("30");
  });

  it("applies deviations to notification data nodes", async () => {
    const schema = await compile(`module notifdev {
      namespace "urn:notifdev"; prefix r;
      notification oven-alert {
        leaf severity { type string; }
      }
      deviation "/r:oven-alert/r:severity" { deviate add { default "critical"; } }
    }`);
    expect(schema.diagnostics.map(item => item.code)).toEqual([]);
    const alert = schema.operations.find(operation => operation.name === "oven-alert")!;
    expect(alert.data.find(node => node.name === "severity")!.properties.default?.[0]?.argument).toBe("critical");
  });

  it("applies deviations to nested action input parameters", async () => {
    const schema = await compile(`module actdev {
      namespace "urn:actdev"; prefix r;
      container machine {
        action reset {
          input { leaf delay { type uint16; } }
        }
      }
      deviation "/r:machine/r:reset/r:input/r:delay" { deviate add { default "5"; } }
    }`);
    expect(schema.diagnostics.map(item => item.code)).toEqual([]);
    const reset = schema.operations.find(operation => operation.name === "reset")!;
    expect(reset.input.find(node => node.name === "delay")!.properties.default?.[0]?.argument).toBe("5");
  });
});

/** Stage 7b P1 (ROADMAP §152): prefixed refine/uses-augment targets (RFC 7950 §7.13.2/§7.17). */
describe("prefixed refine and uses-augment targets", () => {
  it("resolves a prefixed refine target", async () => {
    const schema = await compileAll(`module grpm {
      namespace "urn:grpm"; prefix g;
      grouping payload { leaf level { type string; } }
      container direct { uses payload; }
    }`, `module userm {
      namespace "urn:userm"; prefix u;
      import grpm { prefix g2; }
      container site { uses g2:payload { refine g2:level { mandatory true; } } }
    }`);
    expect(schema.diagnostics.map(item => item.code)).toEqual([]);
    // Pre-fix the target was matched by plain name only ('g2:level') and the
    // refine was reported unresolved-refine.
    const level = schema.roots.find(root => root.name === "site")!.children.find(child => child.name === "level")!;
    expect(level.properties.mandatory?.[0]?.argument).toBe("true");
  });

  it("resolves a prefixed uses-augment target", async () => {
    const schema = await compileAll(`module grpm2 {
      namespace "urn:grpm2"; prefix g;
      grouping payload { container inner { leaf core { type string; } } }
      container direct { uses payload; }
    }`, `module userm2 {
      namespace "urn:userm2"; prefix u;
      import grpm2 { prefix g2; }
      container site {
        uses g2:payload { augment "g2:inner" { leaf extra { type string; } } }
      }
    }`);
    expect(schema.diagnostics.map(item => item.code)).toEqual([]);
    const inner = schema.roots.find(root => root.name === "site")!.children.find(child => child.name === "inner")!;
    expect(inner.children.find(child => child.name === "extra")).toBeDefined();
  });
});
