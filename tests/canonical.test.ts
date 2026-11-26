import { describe, expect, it } from "vitest";
import { canonicalFormOf, createFormModel, parseYang } from "../src/index.js";

const canonical = (text: string, path: string, value: unknown): string | undefined => {
  const model = createFormModel(parseYang(text));
  const field = model.fields.find(item => item.path === path) ?? model.fields[0]!;
  return canonicalFormOf(field, value);
};

describe("canonical value representations", () => {
  it("canonicalizes integers and rejects out-of-range or non-lexical values", () => {
    const text = `module nums {
      namespace "urn:nums"; prefix n;
      leaf small { type int32; }
      leaf big { type uint64; }
    }`;
    expect(canonical(text, "/small", "007")).toBe("7");
    expect(canonical(text, "/small", "+41")).toBe("41");
    expect(canonical(text, "/small", -130)).toBe("-130");
    expect(canonical(text, "/small", "0x10")).toBeUndefined();
    expect(canonical(text, "/small", "2147483648")).toBeUndefined();
    expect(canonical(text, "/big", "18446744073709551615")).toBe("18446744073709551615");
    expect(canonical(text, "/big", "18446744073709551616")).toBeUndefined();
  });

  it("re-renders decimal64 with exactly its fraction digits", () => {
    const text = `module dec {
      namespace "urn:dec"; prefix d;
      typedef price { type decimal64 { fraction-digits 3; } }
      leaf amount { type price; }
    }`;
    expect(canonical(text, "/amount", "1.5")).toBe("1.500");
    expect(canonical(text, "/amount", "-0.50")).toBe("-0.500");
    expect(canonical(text, "/amount", 2)).toBe("2.000");
    expect(canonical(text, "/amount", "1.5001")).toBeUndefined();
  });

  it("normalizes boolean, enum, bits and binary forms", () => {
    const text = `module mixed {
      namespace "urn:mixed"; prefix m;
      leaf on { type boolean; }
      leaf choice { type enumeration { enum fast; enum slow; } }
      leaf flags {
        type bits {
          bit zero; bit one { position 5; }
        }
      }
      leaf blob { type binary; }
    }`;
    expect(canonical(text, "/on", true)).toBe("true");
    expect(canonical(text, "/on", "false")).toBe("false");
    expect(canonical(text, "/on", "sometimes")).toBeUndefined();
    expect(canonical(text, "/choice", "fast")).toBe("fast");
    expect(canonical(text, "/choice", "fast ")).toBeUndefined();
    // Canonical bits order follows positions: declaration order otherwise.
    expect(canonical(text, "/flags", "one zero")).toBe("zero one");
    expect(canonical(text, "/flags", "zero two")).toBeUndefined();
    expect(canonical(text, "/blob", "aGVsbG8=")).toBe("aGVsbG8=");
    expect(canonical(text, "/blob", "aGVs bG8=")).toBe("aGVsbG8=");
    expect(canonical(text, "/blob", "not-base64!")).toBeUndefined();
  });

  it("returns undefined for cross-reference types and keeps strings as-is", () => {
    const text = `module xr {
      namespace "urn:xr"; prefix x;
      leaf self { type leafref { path "../self"; } }
      leaf label { type string { length "1..3"; } }
    }`;
    expect(canonical(text, "/self", "/self")).toBeUndefined();
    expect(canonical(text, "/label", "ok")).toBe("ok");
  });

  it("does not invent canonical forms for identityref or instance-identifier", () => {
    const text = `module contextual {
      namespace "urn:contextual"; prefix c;
      identity root;
      leaf identity { type identityref { base root; } }
      leaf target { type instance-identifier; }
    }`;
    expect(canonical(text, "/identity", "c:root")).toBeUndefined();
    expect(canonical(text, "/target", "/c:somewhere/c:node")).toBeUndefined();
  });
});
