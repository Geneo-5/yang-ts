import { describe, expect, it } from "vitest";
import { childOf, parseYang, YangSyntaxError } from "../src/index.js";

describe("YANG statement parser", () => {
  it("parses nested statements, comments, and quoted arguments", () => {
    const module = parseYang(`module sample { // comment\n yang-version 1.1; namespace "urn:sample"; prefix s;\n leaf mode { type enumeration { enum a; enum b; } must \". != 'off'\"; } }`);
    expect(module.argument).toBe("sample");
    expect(childOf(module, "namespace")?.argument).toBe("urn:sample");
    const leaf = childOf(module, "leaf")!;
    expect(childOf(leaf, "type")?.children.map(s => s.argument)).toEqual(["a", "b"]);
    expect(childOf(leaf, "must")?.argument).toBe(". != 'off'");
  });

  it("concatenates RFC 7950 adjacent quoted strings", () => {
    const module = parseYang(`module sample { namespace "urn:" + "sample"; prefix s; }`);
    expect(childOf(module, "namespace")?.argument).toBe("urn:sample");
  });

  it("reports malformed source with a location", () => {
    expect(() => parseYang("module bad { leaf x {")).toThrow(YangSyntaxError);
  });
});
