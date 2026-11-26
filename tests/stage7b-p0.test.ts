import { describe, expect, it } from "vitest";
import { compileYangModules, parseYang, resolveModuleSet } from "../src/index.js";

const compile = async (text: string) => compileYangModules(await resolveModuleSet([parseYang(text)], { async loadModule() { return undefined; } }));

/** Stage 7b P0 (ROADMAP §141): §6.2.1 scoping for definitions nested in data nodes and operations. */
describe("typedef/grouping scopes declared inside data nodes and operations", () => {
  it("resolves a typedef declared inside a container from its descendants", async () => {
    const schema = await compile(`module scoped {
      namespace "urn:scoped"; prefix s;
      container box {
        typedef local-type { type string; }
        leaf inner { type local-type; }
      }
    }`);
    expect(schema.diagnostics.map(d => `${d.code}: ${d.message}`)).toEqual([]);
    const inner = schema.roots.find(root => root.name === "box")!.children.find(child => child.name === "inner")!;
    expect(inner.resolvedType).toBe("string");
  });

  it("lets an inner declaration shadow an outer one of the same document", async () => {
    const schema = await compile(`module shadow {
      namespace "urn:shadow"; prefix s;
      typedef generic { type uint16; }
      grouping payload {
        typedef generic { type uint32; }
        container boxed {
          typedef generic { type uint8; }
          leaf local { type generic; }
        }
        leaf outer { type generic; }
      }
      leaf top { type generic; }
      container usesite { uses payload; }
    }`);
    expect(schema.diagnostics.map(d => `${d.code}: ${d.message}`)).toEqual([]);
    const payload = schema.roots.find(root => root.name === "usesite")!;
    const local = payload.children.find(child => child.name === "boxed")!.children.find(child => child.name === "local")!;
    expect(local.resolvedType).toBe("uint8");
    const outer = payload.children.find(child => child.name === "outer")!;
    expect(outer.resolvedType).toBe("uint32");
    expect(schema.roots.find(root => root.name === "top")!.resolvedType).toBe("uint16");
  });

  it("never lets a using-site declaration shadow a grouping's own reference", async () => {
    const schema = await compile(`module shadow {
      namespace "urn:shadow"; prefix s;
      typedef generic { type uint16; }
      grouping payload { leaf value { type generic; } }
      container boxed {
        typedef generic { type uint8; }
        uses payload;
      }
      leaf top { type generic; }
    }`);
    expect(schema.diagnostics.map(d => `${d.code}: ${d.message}`)).toEqual([]);
    const boxedLeaf = schema.roots.find(root => root.name === "boxed")!.children.find(child => child.name === "value")!;
    expect(boxedLeaf.resolvedType).toBe("uint16");
    expect(schema.roots.find(root => root.name === "top")!.resolvedType).toBe("uint16");
  });

  it("scopes rpc input/output typedefs and nested groupings to their operation", async () => {
    const schema = await compile(`module opscope {
      namespace "urn:opscope"; prefix s;
      rpc probe {
        input {
          typedef token { type string; }
          grouping auth { leaf header { type token; } }
          uses auth;
        }
        output {
          typedef receipt { type uint32; }
          leaf id { type receipt; }
        }
      }
    }`);
    expect(schema.diagnostics.map(d => `${d.code}: ${d.message}`)).toEqual([]);
    const operation = schema.operations.find(operation => operation.name === "probe")!;
    expect(operation.input.find(node => node.name === "header")!.resolvedType).toBe("string");
    expect(operation.output.find(node => node.name === "id")!.resolvedType).toBe("uint32");
  });

  it("does not leak a container-scoped grouping to the top level", async () => {
    const schema = await compile(`module leak {
      namespace "urn:leak"; prefix s;
      container box {
        grouping hidden { leaf inner { type string; } }
      }
      uses hidden;
    }`);
    expect(schema.diagnostics.map(item => item.code)).toContain("unresolved-grouping");
  });
});
