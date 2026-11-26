import { describe, expect, it } from "vitest";
import { BUILTIN_TYPES, RESTRICTION_BUILTINS } from "../src/types/builtins.js";

describe("shared RFC 7950 §9 built-in type registry", () => {
  it("lists exactly the twenty built-in types of RFC 7950 section 9", () => {
    expect([...BUILTIN_TYPES].sort()).toEqual([
      "binary", "bits", "boolean", "decimal64", "empty", "enumeration", "identityref", "instance-identifier",
      "int8", "int16", "int32", "int64", "leafref", "string", "uint8", "uint16", "uint32", "uint64", "union",
    ].sort());
  });

  it("restricts each restriction statement to the built-in kinds that accept it", () => {
    expect([...RESTRICTION_BUILTINS.range!].sort()).toEqual(["decimal64", "int16", "int32", "int64", "int8", "uint16", "uint32", "uint64", "uint8"].sort());
    expect([...RESTRICTION_BUILTINS.length!].sort()).toEqual(["binary", "string"]);
    expect([...RESTRICTION_BUILTINS.pattern!]).toEqual(["string"]);
    expect([...RESTRICTION_BUILTINS.path!]).toEqual(["leafref"]);
    expect([...RESTRICTION_BUILTINS["require-instance"]!].sort()).toEqual(["instance-identifier", "leafref"]);
    expect([...RESTRICTION_BUILTINS["fraction-digits"]!]).toEqual(["decimal64"]);
    expect([...RESTRICTION_BUILTINS.base!]).toEqual(["identityref"]);
    expect([...RESTRICTION_BUILTINS.enum!]).toEqual(["enumeration"]);
    expect([...RESTRICTION_BUILTINS.bit!]).toEqual(["bits"]);
  });

  it("never allows a restriction on a type outside the registry", () => {
    for (const allowed of Object.values(RESTRICTION_BUILTINS)) {
      for (const name of allowed!) expect(BUILTIN_TYPES.has(name)).toBe(true);
    }
  });
});
