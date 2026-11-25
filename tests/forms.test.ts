import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFormModel, parseYang, validateFormValue } from "../src/index.js";

const oven = parseYang(readFileSync(fileURLToPath(new URL("./fixtures/yang/sysrepo/oven.yang", import.meta.url)), "utf8"));
const model = createFormModel(oven);

describe("form helper", () => {
  it("builds enum choices and help from the Sysrepo oven RPC input", () => {
    const field = model.fields.find(item => item.path === "/insert-food/input/time")!;
    expect(field.control).toBe("enum");
    expect(field.options.map(option => option.value)).toEqual(["now", "on-oven-ready"]);
    expect(field.options[1]?.description).toContain("temperature inside");
    expect(validateFormValue(field, "now").status).toBe("valid");
    expect(validateFormValue(field, "later")).toMatchObject({
      status: "invalid", errors: [{ code: "type.enum" }],
    });
  });

  it("resolves local typedefs and enforces integer bounds and typedef ranges", () => {
    const field = model.fields.find(item => item.path === "/oven/temperature")!;
    expect(field.yangType).toBe("uint8");
    expect(field.unresolvedType).toBe(false);
    expect(field.defaultValue).toBe("0");
    expect(field.help).toContain("Temperature range");
    expect(validateFormValue(field, "250").status).toBe("valid");
    expect(validateFormValue(field, "251")).toMatchObject({ status: "invalid", errors: [{ code: "constraint.range" }] });
    expect(validateFormValue(field, "-1").status).toBe("invalid");
  });

  it("exposes required and read-only metadata and validates booleans", () => {
    const turnedOn = model.fields.find(item => item.path === "/oven/turned-on")!;
    expect(turnedOn.control).toBe("boolean");
    expect(turnedOn.defaultValue).toBe("false");
    expect(validateFormValue(turnedOn, true).status).toBe("valid");
    expect(validateFormValue(turnedOn, "sometimes").status).toBe("invalid");
    const state = model.fields.find(item => item.path === "/oven-state/temperature")!;
    expect(state.readOnly).toBe(true);
  });

  it("reports unsupported must constraints as pending instead of claiming full validity", () => {
    const constrained = parseYang(`module check { namespace "urn:check"; prefix c; leaf value { type string; must ". = 'ok'" { error-message "must be ok"; } } }`);
    const field = createFormModel(constrained).fields[0]!;
    const result = validateFormValue(field, "ok");
    expect(result.status).toBe("indeterminate");
    expect(result.pending).toMatchObject([{ kind: "must", expression: ". = 'ok'", errorMessage: "must be ok" }]);
  });

  it("returns an explicit incomplete result for unresolved typedefs", () => {
    const unresolved = parseYang(`module check { namespace "urn:check"; prefix c; leaf value { type missing-type; } }`);
    const field = createFormModel(unresolved).fields[0]!;
    expect(field.unresolvedType).toBe(true);
    expect(validateFormValue(field, "anything").status).toBe("indeterminate");
  });

  it("validates leaf-list cardinality and each enum value", () => {
    const module = parseYang(`module check { namespace "urn:check"; prefix c; leaf-list tags { type enumeration { enum red; enum blue; } min-elements 1; max-elements 2; } }`);
    const field = createFormModel(module).fields[0]!;
    expect(field.multiple).toBe(true);
    expect(validateFormValue(field, ["red", "blue"]).status).toBe("valid");
    expect(validateFormValue(field, ["red", "green"]).status).toBe("invalid");
    expect(validateFormValue(field, []).errors[0]?.code).toBe("constraint.min-elements");
    expect(validateFormValue(field, undefined).errors[0]?.code).toBe("constraint.min-elements");
  });

  it("reports pattern constraints as indeterminate instead of using incompatible JavaScript regex rules", () => {
    const module = parseYang(`module check { namespace "urn:check"; prefix c; leaf name { type string { pattern '[a-z]+'; } } }`);
    const field = createFormModel(module).fields[0]!;
    expect(validateFormValue(field, "valid")).toMatchObject({
      status: "indeterminate", pending: [{ kind: "unsupported", expression: "pattern requires XML Schema regular-expression evaluation" }],
    });
  });

  it("validates decimal64 precision and declared ranges", () => {
    const module = parseYang(`module check { namespace "urn:check"; prefix c; leaf ratio { type decimal64 { fraction-digits 2; range "0.00..10.00"; } } }`);
    const field = createFormModel(module).fields[0]!;
    expect(validateFormValue(field, "9.95").status).toBe("valid");
    expect(validateFormValue(field, "10.01").status).toBe("invalid");
    expect(validateFormValue(field, "1.234").errors[0]?.code).toBe("type.decimal64.precision");
  });

  it("resolves min and max in derived ranges against the base type bounds", () => {
    const module = parseYang(`module ranges { namespace "urn:ranges"; prefix r;
      typedef byte-range { type uint8 { range "2..8"; } }
      typedef narrowed-byte { type byte-range { range "4..max"; } }
      typedef base-name { type string { length "2..5"; } }
      typedef longer-name { type base-name { length "3..max"; } }
      typedef base-ratio { type decimal64 { fraction-digits 2; range "1.00..5.00"; } }
      typedef high-ratio { type base-ratio { range "3.00..max"; } }
      leaf byte { type narrowed-byte; }
      leaf name { type longer-name; }
      leaf ratio { type high-ratio; }
    }`);
    const fields = createFormModel(module).fields;
    const byte = fields.find(field => field.name === "byte")!;
    const name = fields.find(field => field.name === "name")!;
    const ratio = fields.find(field => field.name === "ratio")!;
    expect(validateFormValue(byte, "4").status).toBe("valid");
    expect(validateFormValue(byte, "3").status).toBe("invalid");
    expect(validateFormValue(byte, "9").status).toBe("invalid");
    expect(validateFormValue(name, "abc").status).toBe("valid");
    expect(validateFormValue(name, "abcdef").status).toBe("invalid");
    expect(validateFormValue(ratio, "3.00").status).toBe("valid");
    expect(validateFormValue(ratio, "5.01").status).toBe("invalid");
  });

  it("filters inherited enum and bits options through typedef restrictions", () => {
    const module = parseYang(`module subsets { namespace "urn:subsets"; prefix s;
      typedef full-mode { type enumeration { enum safe; enum normal; enum debug; } }
      typedef limited-mode { type full-mode { enum safe; enum normal; } }
      typedef full-flags { type bits { bit read; bit write; bit admin; } }
      typedef limited-flags { type full-flags { bit read; bit write; } }
      leaf mode { type limited-mode; }
      leaf flags { type limited-flags; }
    }`);
    const fields = createFormModel(module).fields;
    const mode = fields.find(field => field.name === "mode")!;
    const flags = fields.find(field => field.name === "flags")!;
    expect(mode.options.map(option => option.value)).toEqual(["safe", "normal"]);
    expect(flags.options.map(option => option.value)).toEqual(["read", "write"]);
    expect(validateFormValue(mode, "debug").status).toBe("invalid");
    expect(validateFormValue(flags, ["admin"]).status).toBe("invalid");
    expect(validateFormValue(flags, ["read", "write"]).status).toBe("valid");
  });

  it("validates union values against members in declaration order", () => {
    const module = parseYang(`module unions { namespace "urn:unions"; prefix u;
      leaf value { type union {
        type uint16 { range "1..10"; }
        type enumeration { enum automatic; }
      } }
    }`);
    const field = createFormModel(module).fields[0]!;
    expect(validateFormValue(field, "7").status).toBe("valid");
    expect(validateFormValue(field, "automatic").status).toBe("valid");
    expect(validateFormValue(field, "20")).toMatchObject({ status: "invalid", errors: [{ code: "type.union" }] });
  });

  it("validates canonical base64 binary values and length in octets", () => {
    const module = parseYang(`module binary-values { namespace "urn:binary-values"; prefix b;
      leaf payload { type binary { length "3"; } }
    }`);
    const field = createFormModel(module).fields[0]!;
    expect(validateFormValue(field, "AQID").status).toBe("valid");
    expect(validateFormValue(field, "AQI=")).toMatchObject({ status: "invalid", errors: [{ code: "constraint.length" }] });
    expect(validateFormValue(field, "AB==")).toMatchObject({ status: "invalid", errors: [{ code: "type.binary.base64" }] });
    expect(validateFormValue(field, "not base64")).toMatchObject({ status: "invalid", errors: [{ code: "type.binary.base64" }] });
  });

  it("resolves imported typedefs only when their dependency module is supplied", () => {
    const interfaces = parseYang(readFileSync(fileURLToPath(new URL("./fixtures/yang/standard/ietf/RFC/ietf-interfaces@2018-02-20.yang", import.meta.url)), "utf8"));
    const yangTypes = parseYang(readFileSync(fileURLToPath(new URL("./fixtures/yang/standard/ietf/RFC/ietf-yang-types@2013-07-15.yang", import.meta.url)), "utf8"));
    const complete = createFormModel(interfaces, { modules: [yangTypes] });
    const incomplete = createFormModel(interfaces);
    const speed = complete.fields.find(field => field.path === "/interfaces/interface[*]/speed")!;
    const unresolvedSpeed = incomplete.fields.find(field => field.path === "/interfaces/interface[*]/speed")!;
    expect(speed.yangType).toBe("uint64");
    expect(speed.unresolvedType).toBe(false);
    expect(speed.readOnly).toBe(true);
    expect(unresolvedSpeed.unresolvedType).toBe(true);
    expect(validateFormValue(unresolvedSpeed, "100").status).toBe("indeterminate");
  });
});
