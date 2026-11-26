import { describe, expect, it } from "vitest";
import { compileYangModules, parseYang, resolveModuleSet, validateDataTree } from "../src/index.js";
import { parseXml } from "./dom.js";

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

/** Stage 7b P0 (ROADMAP §142): leafref paths of typedefs compile in the typedef's declaring module. */
describe("leafref declared through a typedef across modules", () => {
  const schemaWith = async (typedefBody: string) => {
    const schema = compileYangModules(await resolveModuleSet([
      parseYang(`module lib {
        namespace "urn:lib"; prefix l;
        container items {
          list item { key name; leaf name { type string; } leaf value { type string; } }
        }
        typedef item-ref { ${typedefBody} }
      }`),
      parseYang(`module user {
        namespace "urn:user"; prefix u;
        import lib { prefix o; }
        augment "/o:items" { leaf watch { type o:item-ref; } }
      }`),
    ], { async loadModule() { return undefined; } }));
    expect(schema.diagnostics.map(item => item.code)).toEqual([]);
    return schema;
  };
  // RFC 7950 section 7.17: an augmented node carries the augmenting module's
  // namespace, so <watch> is qualified with urn:user while living in <items>.
  const instance = `<items xmlns="urn:lib">
    <item><name>n1</name><value>a</value></item>
    <item><name>n2</name><value>b</value></item>
    <watch xmlns="urn:user">n2</watch>
  </items>`;

  it("keeps prefixed typedef paths valid when the using module renames the prefix", async () => {
    const schema = await schemaWith(`type leafref { path "/l:items/l:item/l:name"; }`);
    // Pre-fix: the path compiles in the *using* module, where no `l` prefix
    // exists, and validateDataTree throws "Cannot resolve QName l".
    expect(validateDataTree(schema, parseXml(instance))).toMatchObject({ status: "valid", issues: [] });
  });

  it("qualifies unprefixed typedef paths with the declaring module's namespace", async () => {
    const schema = await schemaWith(`type leafref { path "/items/item/name"; }`);
    // Pre-fix: unprefixed steps take the using module's namespace so the path
    // matches nothing and valid data reports a false leafref-dangling.
    expect(validateDataTree(schema, parseXml(instance))).toMatchObject({ status: "valid", issues: [] });
  });

  it("reports indeterminate instead of throwing when the path cannot compile", async () => {
    const schema = await schemaWith(`type leafref { path "/ghost:missing/leaf"; }`);
    const result = validateDataTree(schema, parseXml(instance));
    expect(result.status).toBe("indeterminate");
    expect(result.issues.map(item => item.code)).not.toContain("leafref-dangling");
  });
});
