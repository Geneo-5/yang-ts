import { describe, expect, it } from "vitest";
import { createFormModel, parseYang, validateFormValue } from "../src/index.js";

const field = (text: string, path?: string) => {
  const model = createFormModel(parseYang(text));
  return path ? model.fields.find(item => item.path === path) ?? model.fields[0]! : model.fields[0]!;
};

const settled = (field_: ReturnType<typeof field>, value: unknown) => validateFormValue(field_, value);

describe("RFC 6991 integer boundary corpus", () => {
  const leaf = (type: string) => `module bounds {
    namespace "urn:bounds"; prefix b;
    leaf probe { type ${type}; }
  }`;

  it("accepts exactly the signed width boundaries and rejects one past them", () => {
    expect(settled(field(leaf("int8")), "-128").status).toBe("valid");
    expect(settled(field(leaf("int8")), "127").status).toBe("valid");
    expect(settled(field(leaf("int8")), "-129").errors[0]?.code).toBe("constraint.range");
    expect(settled(field(leaf("int8")), "128").errors[0]?.code).toBe("constraint.range");

    expect(settled(field(leaf("int64")), "-9223372036854775808").status).toBe("valid");
    expect(settled(field(leaf("int64")), "9223372036854775807").status).toBe("valid");
    // Exact bigint inputs stay exact; JavaScript doubles cannot.
    expect(settled(field(leaf("int64")), -9223372036854775808n).status).toBe("valid");
    expect(settled(field(leaf("int64")), 9223372036854775807.5).errors[0]?.code).toBe("type.integer.precision");
  });

  it("accepts exactly the unsigned width boundaries", () => {
    expect(settled(field(leaf("uint8")), "255").status).toBe("valid");
    expect(settled(field(leaf("uint8")), "-0").status).toBe("valid");
    expect(settled(field(leaf("uint8")), "256").errors[0]?.code).toBe("constraint.range");
    expect(settled(field(leaf("uint16")), "65535").status).toBe("valid");
    expect(settled(field(leaf("uint32")), "4294967295").status).toBe("valid");
    expect(settled(field(leaf("uint64")), "18446744073709551615").status).toBe("valid");
    expect(settled(field(leaf("uint64")), "18446744073709551616").status).toBe("invalid");
    expect(settled(field(leaf("uint64")), "-1").status).toBe("invalid");
  });

  it("enforces inherited range restrictions through typedef chains", () => {
    const chained = `module chain {
      namespace "urn:chain"; prefix c;
      typedef base { type int32 { range "-100 .. 100"; } }
      typedef middle { type base; }
      leaf probe { type middle { range "10 .. 90"; } }
    }`;
    const probe = field(chained);
    expect(settled(probe, "10").status).toBe("valid");
    expect(settled(probe, "90").status).toBe("valid");
    expect(settled(probe, "9").errors[0]?.code).toBe("constraint.range");
    expect(settled(probe, "91").errors[0]?.code).toBe("constraint.range");
    // The narrower derived range wins over the base.
    expect(settled(probe, "-5").errors[0]?.code).toBe("constraint.range");
  });
});

describe("RFC 6991 decimal64 boundary corpus", () => {
  it("accepts the scaled range limits and rejects beyond them", () => {
    const text = `module dec {
      namespace "urn:dec"; prefix d;
      leaf probe { type decimal64 { fraction-digits 2; } }
    }`;
    const probe = field(text);
    expect(settled(probe, "92233720368547758.07").status).toBe("valid");
    expect(settled(probe, "-92233720368547758.08").status).toBe("valid");
    expect(settled(probe, "92233720368547758.08").errors[0]?.code).toBe("constraint.decimal64.range");
    expect(settled(probe, "1.234").errors[0]?.code).toBe("type.decimal64.precision");
  });

  it("defines fraction digits through derived typedefs", () => {
    const text = `module dec2 {
      namespace "urn:dec2"; prefix d;
      typedef temperature { type decimal64 { fraction-digits 1; range "-50 .. 150"; } }
      leaf probe { type temperature; }
    }`;
    const probe = field(text);
    expect(settled(probe, "150.0").status).toBe("valid");
    expect(settled(probe, "150.1").errors[0]?.code).toBe("constraint.range");
    expect(settled(probe, "1.25").errors[0]?.code).toBe("type.decimal64.precision");
  });
});

describe("RFC 7950 string and binary boundary corpus", () => {
  it("enforces inherited length bounds with primitive counter-examples at the edges", () => {
    const text = `module str {
      namespace "urn:str"; prefix s;
      typedef name { type string { length "2 .. 4"; } }
      leaf probe { type name { length "3"; } }
    }`;
    const probe = field(text);
    expect(settled(probe, "abc").status).toBe("valid");
    expect(settled(probe, "ab")).toHaveProperty("status", "invalid");
    expect(settled(probe, "abcd")).toHaveProperty("status", "invalid");
  });

  it("anchors derived patterns and keeps unsupported XML Schema syntax pending", () => {
    const text = `module pat {
      namespace "urn:pat"; prefix p;
      typedef host { type string { pattern "[a-z]+"; } }
      leaf probe { type host; }
    }`;
    const probe = field(text);
    expect(settled(probe, "example").status).toBe("valid");
    // Implicit anchoring: a partial match is not a match.
    expect(settled(probe, "Example1").status).toBe("invalid");
    const unsupported = field(`module pat2 {
      namespace "urn:pat2"; prefix p;
      leaf probe { type string { pattern 'a\\1'; } }
    }`);
    expect(settled(unsupported, "a").status).toBe("indeterminate");
  });

  it("validates binary octet-length boundaries over canonical base64", () => {
    const text = `module bin {
      namespace "urn:bin"; prefix b;
      leaf probe { type binary { length "1 .. 3"; } }
    }`;
    const probe = field(text);
    expect(settled(probe, "AA==").status).toBe("valid"); // 1 octet
    expect(settled(probe, "AAA=").status).toBe("valid"); // 2 octets
    expect(settled(probe, "AAAA").status).toBe("valid"); // 3 octets
    expect(settled(probe, "AAAAAA==").errors[0]?.code).toBe("constraint.length"); // 4 octets
    expect(settled(probe, "A").errors[0]?.code).toBe("type.binary.base64");
  });
});

describe("RFC 6991 enumeration, bits and identityref restrictions", () => {
  it("rejects values removed by derived typedef restrictions after wiring candidates", () => {
    const text = `module opts {
      namespace "urn:opts"; prefix o;
      typedef modes { type enumeration { enum auto; enum manual; enum hybrid; } }
      leaf probe { type modes { enum manual; } }
    }`;
    const probe = field(text);
    expect(settled(probe, "manual").status).toBe("valid");
    expect(settled(probe, "auto").status).toBe("invalid");
  });

  it("validates bit boundaries by position", () => {
    const text = `module bits {
      namespace "urn:bits"; prefix b;
      leaf probe { type bits { bit low; bit mid { position 16; } bit high { position 64; } } }
    }`;
    const probe = field(text);
    expect(settled(probe, ["high", "low"]).status).toBe("valid");
    expect(settled(probe, "low mid").status).toBe("valid");
    expect(settled(probe, ["low", "unknown"]).status).toBe("invalid");
    expect(settled(probe, ["low", "low"]).status).toBe("invalid");
  });
});
