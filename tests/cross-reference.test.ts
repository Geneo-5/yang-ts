import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { compileYangModules, createFormModel, parseYang, resolveModuleSet, validateFormValue } from "../src/index.js";
import { parseXml } from "./dom.js";

const instance = (xml: string) => parseXml(xml);

const schema = compileYangModules(await resolveModuleSet([parseYang(`module routing {
  namespace "urn:routing"; prefix r;
  identity tunnel-type;
  identity gre { base tunnel-type; }
  identity ipsec { base tunnel-type; }
  identity lisp { base tunnel-type; }
  import other {
    prefix o;
  }
  container topology {
    list route { key name; leaf name { type string; } leaf next-hop { type string; } }
    leaf gateway { type leafref { path "../route/name"; } }
    leaf tunnel {
      type identityref { base tunnel-type; base o:legacy-type; }
    }
  }
}`), parseYang(`module other {
  namespace "urn:other"; prefix o;
  identity legacy-type;
  identity dial-up { base legacy-type; }
}`)], { async loadModule() { return undefined; } }));
expect(schema.diagnostics).toEqual([]);

const model = createFormModel(parseYang(`module routing {
  namespace "urn:routing"; prefix r;
  import other { prefix o; }
  identity tunnel-type;
  identity gre { base tunnel-type; }
  identity ipsec { base tunnel-type; }
  identity lisp { base tunnel-type; }
  container topology {
    list route { key name; leaf name { type string; } leaf next-hop { type string; } }
    leaf gateway { type leafref { path "../route/name"; } }
    leaf tunnel {
      type identityref { base tunnel-type; base o:legacy-type; }
    }
  }
}`));
const gateway = model.fields.find(item => item.path === "/topology/gateway")!;
const tunnel = model.fields.find(item => item.path === "/topology/tunnel")!;

const routingDoc = instance(`<routing xmlns="urn:routing">
  <route><name>core</name><next-hop>10.0.0.1</next-hop></route>
  <route><name>edge</name><next-hop>10.0.0.2</next-hop></route>
</routing>`);
// The form value is not committed to the document yet: probe with a
// placeholder element in the position the filled field would occupy.
const anchor = routingDoc.createElement("gateway");
routingDoc.documentElement!.appendChild(anchor);
const context = { schema, anchor };

describe("form cross-reference validation", () => {
  it("validates leafref values against sibling instance data", () => {
    const valid = validateFormValue(gateway, "core", context);
    expect(valid.status).toBe("valid");
    expect(valid.errors).toEqual([]);
    expect(valid.pending).toEqual([]);

    const dangling = validateFormValue(gateway, "spine", context);
    expect(dangling.status).toBe("invalid");
    expect(dangling.errors[0]?.code).toBe("constraint.leafref");
  });

  it("stays indeterminate for leafrefs without a cross-reference context", () => {
    const result = validateFormValue(gateway, "core");
    expect(result.status).toBe("indeterminate");
    expect(result.pending).toMatchObject([{ kind: "unsupported" }]);
  });

  it("checks identityref values against declared bases and derivation", () => {
    expect(validateFormValue(tunnel, "gre", context).status).toBe("valid");
    expect(validateFormValue(tunnel, "routing:gre", context).status).toBe("valid");
    // Prefix-qualified import base resolves through the declaring module.
    expect(validateFormValue(tunnel, "dial-up", context).status).toBe("valid");

    const unrelated = validateFormValue(tunnel, "fallback", context);
    expect(unrelated.status).toBe("invalid");
    expect(unrelated.errors[0]?.code).toBe("type.identityref");
    expect(validateFormValue(tunnel, 42, context).status).toBe("invalid");
  });

  it("stays indeterminate for identityrefs without cross-reference data", () => {
    const result = validateFormValue(tunnel, "gre");
    expect(result.status).toBe("indeterminate");
    expect(result.pending).toMatchObject([{ kind: "unsupported" }]);
  });
});
