/**
 * §212 — binding API: choice active-case selection and list-entry targeting
 * on top of the rebuilt form model (§87).
 *
 * Contract alignment: `formValuesToRestconfBody` stores list entries at the
 * `[*]` list path as an ARRAY of entry records, each record keyed by the FULL
 * child field paths. The binding helpers here speak exactly that shape, so a
 * bound UI can edit one row and splice it back without translating paths.
 */
import { describe, expect, it } from "vitest";
import {
  compileYangModules, parseYang, resolveModuleSet, createFormModel, formValuesToRestconfBody,
  activeCaseFields, activeRequiredValues, listEntryFields, listEntryValues, withListEntry,
} from "../src/index.js";
import type { CompiledYangSchema } from "../src/yang/compiler.js";
import type { FormModel } from "../src/forms/form-model.js";
import type { FormValues } from "../src/forms/restconf-body.js";

const compile = async (text: string): Promise<CompiledYangSchema> =>
  compileYangModules(
    await resolveModuleSet([parseYang(text)], { async loadModule() { return undefined; } }),
  );

const SCHEMA = `module bind {
  namespace "urn:bind"; prefix b;
  container conn {
    choice transport {
      mandatory true;
      case tcp { leaf port { type uint16; mandatory true; } }
      case tls { leaf port { type uint16; mandatory true; } leaf sni { type string; } }
    }
    leaf mode { type string; }
    container routes {
      list route {
        key "name";
        leaf name { type string; }
        leaf target { type string; }
        leaf-list hops { type string; }
      }
    }
  }
}`;

describe("active-case selection (§212)", () => {
  it("keeps always-on fields and selects the active case's fields", async () => {
    const model = createFormModel(await compile(SCHEMA), { module: "bind" });
    const alwaysOn = activeCaseFields(model).map(field => field.path).sort();
    // Only leaves are fields; the choice carries no field until a case wins.
    expect(alwaysOn).toEqual([
      "/conn/mode",
      "/conn/routes/route[*]/hops",
      "/conn/routes/route[*]/name",
      "/conn/routes/route[*]/target",
    ]);
    const tcp = activeCaseFields(model, new Map([["/conn/transport", "tcp"]]));
    expect(tcp.filter(field => field.casePath).map(field => field.path)).toEqual(["/conn/port"]);
    expect(tcp.find(field => field.caseName === "tcp")?.required).toBe(false);
    const tls = activeCaseFields(model, new Map([["/conn/transport", "tls"]]));
    expect(tls.filter(field => field.casePath).map(field => field.path).sort()).toEqual(["/conn/port", "/conn/sni"]);
    // No selection (or an absent name) = only always-on fields.
    expect(activeCaseFields(model, new Map([["/conn/transport", undefined]])).filter(field => field.casePath)).toEqual([]);
  });

  it("throws on unknown choice or case names (binding bugs must be loud)", async () => {
    const model = createFormModel(await compile(SCHEMA), { module: "bind" });
    expect(() => activeCaseFields(model, new Map([["/conn/transport", "quic"]]))).toThrow(/Unknown case 'quic' for choice/);
    expect(() => activeCaseFields(model, new Map([["/conn/nope", "tcp"]]))).toThrow(/Unknown choice '\/conn\/nope'/);
  });

  it("computes the required values of the CURRENT selection", async () => {
    const model = createFormModel(await compile(SCHEMA), { module: "bind" });
    // The list key stays required (an entry cannot exist without it); the
    // active case adds its own mandatory leaves on top.
    const tcp = activeRequiredValues(model, new Map([["/conn/transport", "tcp"]]));
    expect(tcp).toContain("/conn/port");
    expect(tcp).toContain("/conn/routes/route[*]/name");
    // tls case: SAME required path, but sni is optional.
    const tls = activeRequiredValues(model, new Map([["/conn/transport", "tls"]]));
    expect(tls).toContain("/conn/port");
    expect(tls).not.toContain("/conn/sni");
    // Without a selection, no case field is required; keys still are.
    expect(activeRequiredValues(model)).toEqual(["/conn/routes/route[*]/name"]);
  });
});

describe("list-entry targeting (§212)", () => {
  it("scopes entry records keyed by full child field paths", async () => {
    const model = createFormModel(await compile(SCHEMA), { module: "bind" });
    expect(listEntryFields(model, "/conn/routes/route[*]").map(field => field.path)).toEqual([
      "/conn/routes/route[*]/name",
      "/conn/routes/route[*]/target",
      "/conn/routes/route[*]/hops",
    ]);
    const values: FormValues = {
      "/conn/mode": "static",
      "/conn/routes/route[*]": [
        { "/conn/routes/route[*]/name": "core", "/conn/routes/route[*]/target": "10.0.0.1" },
        { "/conn/routes/route[*]/name": "dmz", "/conn/routes/route[*]/hops": ["gw1", "gw2"] },
      ],
    };
    expect(listEntryValues(values, "/conn/routes/route[*]", 1)).toEqual({
      "/conn/routes/route[*]/name": "dmz",
      "/conn/routes/route[*]/hops": ["gw1", "gw2"],
    });
    expect(listEntryValues(values, "/conn/routes/route[*]", 9)).toEqual({});
    // Editing targets one entry, leaves the others untouched, stays plain data.
    const next = withListEntry(values, "/conn/routes/route[*]", 1, {
      "/conn/routes/route[*]/name": "dmz",
      "/conn/routes/route[*]/hops": ["gw3"],
    });
    expect((values["/conn/routes/route[*]"] as unknown[]).length).toBe(2);
    expect(next["/conn/routes/route[*]"]).toEqual([
      { "/conn/routes/route[*]/name": "core", "/conn/routes/route[*]/target": "10.0.0.1" },
      { "/conn/routes/route[*]/name": "dmz", "/conn/routes/route[*]/hops": ["gw3"] },
    ]);
  });

  it("rejects non-array list values and out-of-range targets like the RESTCONF bridge", async () => {
    const model = createFormModel(await compile(SCHEMA), { module: "bind" });
    expect(() => listEntryValues({ "/conn/routes/route[*]": "oops" }, "/conn/routes/route[*]", 0)).toThrow(/must be an array/);
    expect(() => withListEntry({}, "/conn/routes/route[*]", 1, { "/conn/routes/route[*]/name": "x" })).toThrow(/out of range/);
    expect(() => listEntryFields(model, "/conn/unknown[*]")).toThrow(/No form fields under/);
  });

  it("feeds formValuesToRestconfBody directly", async () => {
    const model = createFormModel(await compile(SCHEMA), { module: "bind" });
    const entries: FormValues[] = [];
    const values: FormValues = { "/conn/mode": "static", "/conn/routes/route[*]": entries };
    const appended = withListEntry(values, "/conn/routes/route[*]", entries.length, {
      "/conn/routes/route[*]/name": "core",
      "/conn/routes/route[*]/target": "10.0.0.1",
    });
    expect(formValuesToRestconfBody(model, appended)).toEqual({
      "bind:conn": { mode: "static", routes: { route: [{ name: "core", target: "10.0.0.1" }] } },
    });
  });
});
