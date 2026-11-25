import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { compileYangModules, parseYang, resolveModuleSet, validateDataTree } from "../src/index.js";

const instance = (xml: string) => new DOMParser().parseFromString(xml, "application/xml");

async function compileModule(text: string) {
  const schema = compileYangModules(await resolveModuleSet([parseYang(text)], { async loadModule() { return undefined; } }));
  expect(schema.diagnostics).toEqual([]);
  return schema;
}

describe("data-tree structural validation", () => {
  it("validates list keys, uniqueness and cardinality", async () => {
    const schema = await compileModule(`module devices {
      namespace "urn:devices"; prefix d;
      container devices {
        list device {
          key "name";
          unique "model";
          leaf name { type string; }
          leaf model { type string; }
        }
      }
    }`);
    const tree = `<devices xmlns="urn:devices">`;
    const body = (name: string, model: string) => `<device><name>${name}</name><model>${model}</model></device>`;

    expect(validateDataTree(schema, instance(`${tree}${body("a", "m1")}${body("b", "m2")}</devices>`))).toMatchObject({ status: "valid", issues: [] });
    const duplicateKey = validateDataTree(schema, instance(`${tree}${body("a", "m1")}${body("a", "m2")}</devices>`));
    expect(duplicateKey.issues.map(item => item.code)).toEqual(["duplicate-key"]);
    const duplicateUnique = validateDataTree(schema, instance(`${tree}${body("a", "m1")}${body("b", "m1")}</devices>`));
    expect(duplicateUnique.issues.map(item => item.code)).toEqual(["unique-violation"]);
    const missingKey = validateDataTree(schema, instance(`${tree}<device><model>m</model></device></devices>`));
    expect(missingKey.issues.map(item => item.code)).toEqual(["missing-key"]);
  });

  it("validates mandatory nodes, min/max-elements and duplicates", async () => {
    const schema = await compileModule(`module orders {
      namespace "urn:orders"; prefix o;
      container order {
        leaf id { type string; mandatory true; }
        leaf-list tag { type string; min-elements 1; max-elements 2; }
        container note;
        leaf note2 { type string; }
      }
    }`);
    const ok = validateDataTree(schema, instance(
      `<order xmlns="urn:orders"><id>x</id><tag>t</tag><note/><note2/></order>`));
    expect(ok).toMatchObject({ status: "valid", issues: [] });

    const invalid = validateDataTree(schema, instance(`<order xmlns="urn:orders"><note/><note2/></order>`));
    expect(invalid.issues.map(item => item.code)).toEqual(["missing-mandatory", "too-few-elements"]);
    expect(invalid.status).toBe("invalid");

    const tooMany = validateDataTree(schema, instance(
      `<order xmlns="urn:orders"><id>x</id><tag>1</tag><tag>2</tag><tag>3</tag></order>`));
    expect(tooMany.issues.map(item => [item.code, item.path])).toEqual([["too-many-elements", "/order/tag"]]);

    const duplicated = validateDataTree(schema, instance(
      `<order xmlns="urn:orders"><id>x</id><id>y</id></order>`), );
    expect(duplicated.issues.map(item => item.code)).toEqual(["too-many-elements", "too-few-elements"]);
  });

  it("detects dangling leafrefs and unmet must constraints", async () => {
    const routed = compileYangModules(await resolveModuleSet([parseYang(`module routing {
      namespace "urn:routing"; prefix r;
      container routing {
        list route { key name; leaf name { type string; } }
        leaf chosen { type leafref { path "../route/name"; } }
        leaf egress { type string; when "../chosen = 'r1'"; }
        leaf strict { type string; must "../chosen = 'r1'"; }
      }
    }`)], { async loadModule() { return undefined; } }));
    expect(routed.diagnostics).toEqual([]);

    expect(validateDataTree(routed, instance(
      `<routing xmlns="urn:routing"><route><name>r1</name></route><chosen>r1</chosen><strict>s</strict></routing>`)),
    ).toMatchObject({ status: "valid", issues: [] });

    const dangling = validateDataTree(routed, instance(
      `<routing xmlns="urn:routing"><route><name>r1</name></route><chosen>missing</chosen></routing>`));
    expect(dangling.issues.map(item => [item.code, item.path])).toEqual([["leafref-dangling", "/routing/chosen"]]);

    const must = validateDataTree(routed, instance(
      `<routing xmlns="urn:routing"><route><name>r2</name></route><chosen>r2</chosen><strict>s</strict></routing>`));
    expect(must.issues.map(item => item.code)).toEqual(["must-unmet"]);

    // When-gated mandatory nodes: an unmet when legitimizes absence, a met
    // one makes the missing node an error.
    const conditionalSchema = compileYangModules(await resolveModuleSet([parseYang(`module schedule {
      namespace "urn:schedule"; prefix s;
      container top {
        leaf chosen { type string; }
        leaf egress { type string; when "../chosen = 'r1'"; mandatory true; }
        leaf broken { type string; must "does-not-exist()"; }
      }
    }`)], { async loadModule() { return undefined; } }));
    expect(conditionalSchema.diagnostics).toEqual([]);

    const legitimated = validateDataTree(conditionalSchema, instance(
      `<top xmlns="urn:schedule"><chosen>r2</chosen></top>`));
    expect(legitimated).toMatchObject({ status: "valid", issues: [] });

    const enforced = validateDataTree(conditionalSchema, instance(
      `<top xmlns="urn:schedule"><chosen>r1</chosen></top>`));
    expect(enforced.issues.map(item => [item.code, item.path])).toEqual([["missing-mandatory", "/top/egress"]]);

    // A must whose expression cannot be evaluated stays indeterminate.
    const unknown = validateDataTree(conditionalSchema, instance(
      `<top xmlns="urn:schedule"><chosen>r1</chosen><egress>now</egress><broken>s</broken></top>`));
    expect(unknown.status).toBe("indeterminate");
    expect(unknown.issues).toEqual([]);
  });
});
