/**
 * §87 — the form model rebuilt on CompiledYangSchema: uses expansion,
 * augments, deviations, choice/case exclusivity, action operations, and
 * §48 feature-gated enum/bit options. The module-bridge path
 * (createFormModel(YangModule)) compiles the module on the fly; the primary
 * path walks an already-compiled schema directly.
 */
import { describe, expect, it } from "vitest";
import {
  compileYangModules, parseYang, resolveModuleSet, createFormModel, validateFormValue,
  formValuesToRestconfBody,
} from "../src/index.js";
import { findSchemaNodeByPath } from "../src/xpath/accessible-tree.js";
import type { CompiledYangSchema } from "../src/yang/compiler.js";

const compile = async (modules: readonly string[], options?: Parameters<typeof compileYangModules>[1]): Promise<CompiledYangSchema> =>
  compileYangModules(
    await resolveModuleSet(modules.map(text => parseYang(text)), { async loadModule() { return undefined; } }),
    options,
  );

describe("form model on CompiledYangSchema (§87)", () => {
  it("carries uses expansion, augments and deviations from the compiled tree", async () => {
    const schema = await compile([
      `module base { namespace "urn:fb"; prefix b;
        grouping creds { leaf user { type string; } leaf secret { type string; } }
        container service { uses creds; leaf port { type uint16; } } }`,
      `module extra { namespace "urn:fe"; prefix e; import base { prefix b; }
        augment /b:service { leaf tls { type boolean; } } }`,
    ]);
    const model = createFormModel(schema, { module: "base" });
    const paths = model.fields.map(field => field.path);
    // uses: grouping leaves expand as fields; augment: the second module's leaf joins.
    expect(paths).toEqual(["/service/user", "/service/secret", "/service/port", "/service/tls"]);
    expect(model.fields.find(field => field.path === "/service/tls")?.module).toBe("extra");
    // deviations: deviate-replace type and deviate-add mandatory reshape fields.
    const deviated = await compile([
      `module target { namespace "urn:ft"; prefix t;
        container box { leaf level { type string; } } }`,
      `module deviator { namespace "urn:fd"; prefix d; import target { prefix t; }
        deviation /t:box/t:level { deviate replace { type int8; } deviate add { mandatory true; } } }`,
    ]);
    const field = createFormModel(deviated, { module: "target" }).fields[0]!;
    expect(field.yangType).toBe("int8");
    expect(field.control).toBe("number");
    expect(field.required).toBe(true);
  });

  it("keeps description text through the typedef chain and validates ranges", async () => {
    const schema = await compile([
      `module t { namespace "urn:td"; prefix t;
        typedef percent { type uint8 { range "0..100"; } description "Percentage 0..100."; }
        container load { leaf cpu { type percent; } } }`,
    ]);
    const field = createFormModel(schema).fields[0]!;
    expect(field.yangType).toBe("uint8");
    expect(field.unresolvedType).toBe(false);
    expect(field.help).toContain("Percentage 0..100.");
    expect(validateFormValue(field, "42").status).toBe("valid");
    expect(validateFormValue(field, "101")).toMatchObject({ status: "invalid", errors: [{ code: "constraint.range" }] });
  });

  it("models choice exclusivity: case leaves are not required and cases record their mandatory fields", async () => {
    const schema = await compile([
      `module picker { namespace "urn:tp"; prefix p;
        container conn {
          choice transport {
            mandatory true;
            default tcp;
            case tcp { leaf port { type uint16; mandatory true; } }
            case tls { leaf port { type uint16; mandatory true; } leaf sni { type string; } }
          }
          leaf outside { type string; mandatory true; }
        } }`,
    ]);
    const model = createFormModel(schema);
    const tcpPort = model.fields.find(field => field.path === "/conn/port" && field.caseName === "tcp")!;
    const tlsPort = model.fields.find(field => field.path === "/conn/port" && field.caseName === "tls")!;
    expect(tcpPort.required).toBe(false);
    expect(tcpPort.casePath).toBe("/conn/transport");
    // §87: mandatory-in-case stays required-by-the-case, not unconditionally.
    expect(validateFormValue(tcpPort, undefined).status).toBe("valid");
    const choice = model.choices.find(item => item.path === "/conn/transport")!;
    expect(choice.required).toBe(true);
    expect(choice.defaultCase).toBe("tcp");
    expect(choice.cases).toEqual([
      { name: "tcp", requiredFieldPaths: ["/conn/port"] },
      { name: "tls", requiredFieldPaths: ["/conn/port"] },
    ]);
    expect(tlsPort.casePath).toBe("/conn/transport");
    // §87: outside a choice, mandatory stays required.
    const outside = model.fields.find(field => field.path === "/conn/outside")!;
    expect(outside.required).toBe(true);
    expect(validateFormValue(outside, undefined).status).toBe("invalid");
    // Case fields keep a schema node addressable for cross-reference checks.
    expect(findSchemaNodeByPath(schema, "/conn/outside")?.kind).toBe("leaf");
  });

  it("lists action operations alongside rpcs with their scope-shaped fields", async () => {
    const schema = await compile([
      `module ops { namespace "urn:to"; prefix o;
        container sink { action drain { input { leaf force { type boolean; } } output { leaf drained { type uint32; } } } }
        rpc ping { input { leaf count { type uint8; } } output { leaf pong { type boolean; } } } }`,
    ]);
    const model = createFormModel(schema);
    const kinds = model.operations.map(operation => ({ kind: operation.kind, name: operation.name }));
    expect(kinds).toEqual([
      { kind: "rpc", name: "ping" }, { kind: "action", name: "drain" },
    ]);
    const drain = model.operations.find(operation => operation.name === "drain")!;
    expect(drain.inputFields.map(field => field.path)).toEqual(["/sink/drain/input/force"]);
    expect(drain.inputFields[0]!.scope).toBe("action-input");
    expect(drain.outputFields.map(field => field.path)).toEqual(["/sink/drain/output/drained"]);
    expect(drain.hasInput).toBe(true);
    expect(drain.hasOutput).toBe(true);
    // rpc fields also live on model.fields (the pre-§87 contract for callers).
    expect(model.fields.map(field => field.path)).toContain("/ping/input/count");
    expect(model.fields.map(field => field.path)).toContain("/sink/drain/input/force");
  });

  it("passes notifications through untouched (operations exclude them)", async () => {
    const schema = await compile([
      `module events { namespace "urn:te"; prefix e;
        notification alarm { leaf severity { type string; } } }`,
    ]);
    const model = createFormModel(schema);
    expect(model.operations).toEqual([]);
    // Notification payload nodes are config-false data the form does not model.
    expect(model.fields).toEqual([]);
  });

  it("drops feature-gated enum/bit options and feature-gated nodes per the compiler's feature set (§48)", async () => {
    const gated = await compile([
      `module opt { namespace "urn:tg"; prefix g;
        feature premium;
        container rack {
          leaf mode { type enumeration { enum auto; enum legacy { if-feature premium; } } }
          leaf mask { type bits { bit plain; bit fancy { if-feature premium; } } }
          leaf extra { type string; if-feature premium; }
        } }`,
    ], { enabledFeatures: new Set() });
    const model = createFormModel(gated, { module: "opt" });
    expect(model.fields.map(field => field.path)).toEqual(["/rack/mode", "/rack/mask"]);
    const mode = model.fields.find(field => field.path === "/rack/mode")!;
    // §48: the gated enum value disappears from the options.
    expect(mode.options.map(option => option.value)).toEqual(["auto"]);
    expect(validateFormValue(mode, "legacy")).toMatchObject({ status: "invalid", errors: [{ code: "type.enum" }] });
    const mask = model.fields.find(field => field.path === "/rack/mask")!;
    expect(mask.options.map(option => option.value)).toEqual(["plain"]);
    // When the feature is granted, the gated value returns.
    const granted = await compile([
      `module opt2 { namespace "urn:tg2"; prefix g;
        feature premium;
        container rack { leaf mode { type enumeration { enum auto; enum legacy { if-feature premium; } } } } }`,
    ], { enabledFeatures: new Set(["opt2:premium"]) });
    const enabled = createFormModel(granted, { module: "opt2" }).fields[0]!;
    expect(enabled.options.map(option => option.value)).toEqual(["auto", "legacy"]);
    // Compiled without a feature set, every feature is available (value stays).
    const unrestricted = createFormModel(await compile([
      `module opt3 { namespace "urn:tg3"; prefix g;
        feature premium;
        container rack { leaf mode { type enumeration { enum auto; enum legacy { if-feature premium; } } } } }`,
    ]), { module: "opt3" });
    expect(unrestricted.fields[0]!.options.map(option => option.value)).toEqual(["auto", "legacy"]);
  });

  it("keys RESTCONF top-level resources per module through topModules", async () => {
    const schema = await compile([
      `module one { namespace "urn:tone"; prefix o; container alpha { leaf hit { type boolean; } } }`,
      `module two { namespace "urn:ttwo"; prefix t; container beta { leaf hit { type boolean; } } }`,
    ]);
    const model = createFormModel(schema);
    expect(model.topModules).toEqual({ alpha: "one", beta: "two" });
    expect(model.module).toBe("one");
    const values = { "/alpha/hit": true, "/beta/hit": false };
    // §87: each top-level node is qualified with ITS module, not the model's first.
    expect(formValuesToRestconfBody(model, values)).toEqual({
      "one:alpha": { hit: true },
      "two:beta": { hit: false },
    });
    // An explicit module option scopes the model to one module.
    const scoped = createFormModel(schema, { module: "two" });
    expect(scoped.fields.map(field => field.path)).toEqual(["/beta/hit"]);
    expect(scoped.topModules).toBeUndefined();
  });
});
