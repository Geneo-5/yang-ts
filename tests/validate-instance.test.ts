import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { compileYangModules, parseYang, resolveModuleSet, validateDataTree } from "../src/index.js";
import { parseXml } from "./dom.js";

const instance = (xml: string) => parseXml(xml);

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

  it("validates instance-identifier syntax and resolution", async () => {
    const schema = await compileModule(`module refs {
      namespace "urn:refs"; prefix r;
      container refs {
        leaf positional { config false; type instance-identifier; }
        leaf config-ref { type instance-identifier; }
        list unkeyed { config false; leaf value { type string; } }
        leaf-list tags { type string; }
        list pair { key "name slot"; leaf name { type string; } leaf slot { type string; } }
        list item {
          key name; leaf name { type string; }
          leaf target { type instance-identifier; }
          leaf free { type instance-identifier { require-instance false; } }
        }
      }
    }`);
    const doc = (target: string, free: string) => instance(
      `<refs xmlns="urn:refs" xmlns:r="urn:refs" xmlns:o="urn:other"><item><name>a</name><target>${target}</target><free>${free}</free></item></refs>`);

    const valid = validateDataTree(schema, doc("/r:refs/r:item[r:name='a']", "/r:refs/r:unkeyed[3]"));
    expect(valid.issues).toEqual([]);

    const dangling = validateDataTree(schema, doc("/r:refs/r:item[r:name='missing']", "/r:refs/r:unkeyed[3]"));
    expect(dangling.issues.map(item => item.code)).toEqual(["instance-identifier-dangling"]);

    const invalid = validateDataTree(schema, doc("refs/item", "count(/refs/item)"));
    expect(invalid.issues.map(item => item.code)).toEqual(["instance-identifier-invalid", "instance-identifier-invalid"]);

    const wrongNamespace = validateDataTree(schema, doc("/o:refs/o:item[o:name='a']", "/r:refs/r:unkeyed[3]"));
    expect(wrongNamespace.issues.map(item => item.code)).toEqual(["instance-identifier-invalid"]);

    const wrongPredicateNamespace = validateDataTree(schema, doc("/r:refs/r:item[o:name='a']", "/r:refs/r:unkeyed[3]"));
    expect(wrongPredicateNamespace.issues.map(item => item.code)).toEqual(["instance-identifier-invalid"]);

    const unboundPrefix = validateDataTree(schema, instance(
      `<refs xmlns="urn:refs"><item><name>a</name><target>/x:refs/x:item</target><free>/x:missing</free></item></refs>`));
    expect(unboundPrefix.issues.map(item => item.code)).toEqual(["instance-identifier-invalid", "instance-identifier-invalid"]);

    const emptyFreeForm = validateDataTree(schema, doc("/r:refs/r:item[r:name='a']", " "));
    expect(emptyFreeForm.issues.map(item => item.code)).toEqual(["instance-identifier-invalid"]);

    const positional = validateDataTree(schema, instance(
      `<refs xmlns="urn:refs" xmlns:r="urn:refs"><positional>/r:refs/r:unkeyed[2]</positional><unkeyed><value>a</value></unkeyed><unkeyed><value>b</value></unkeyed></refs>`));
    expect(positional.issues).toEqual([]);

    const leafListValue = validateDataTree(schema, instance(
      `<refs xmlns="urn:refs" xmlns:r="urn:refs"><positional>/r:refs/r:tags[.='x']</positional><tags>x</tags></refs>`));
    expect(leafListValue.issues).toEqual([]);

    const missingListKey = validateDataTree(schema, instance(
      `<refs xmlns="urn:refs" xmlns:r="urn:refs"><positional>/r:refs/r:item</positional><item><name>a</name></item></refs>`));
    expect(missingListKey.issues.map(item => item.code)).toEqual(["instance-identifier-invalid"]);

    const incompleteMultiKey = validateDataTree(schema, instance(
      `<refs xmlns="urn:refs" xmlns:r="urn:refs"><positional>/r:refs/r:pair[r:name='a']</positional></refs>`));
    expect(incompleteMultiKey.issues.map(item => item.code)).toEqual(["instance-identifier-invalid"]);

    const completeMultiKey = validateDataTree(schema, instance(
      `<refs xmlns="urn:refs" xmlns:r="urn:refs"><positional>/r:refs/r:pair[r:name='a'][r:slot='1']</positional><pair><name>a</name><slot>1</slot></pair></refs>`));
    expect(completeMultiKey.issues).toEqual([]);

    const configToState = validateDataTree(schema, instance(
      `<refs xmlns="urn:refs" xmlns:r="urn:refs"><config-ref>/r:refs/r:unkeyed[1]</config-ref><item><name>a</name></item><unkeyed><value>state</value></unkeyed></refs>`));
    expect(configToState.issues.map(item => item.code)).toEqual(["instance-identifier-invalid"]);

    const positionOnKeyedList = validateDataTree(schema, instance(
      `<refs xmlns="urn:refs" xmlns:r="urn:refs"><positional>/r:refs/r:item[1]</positional></refs>`));
    expect(positionOnKeyedList.issues.map(item => item.code)).toEqual(["instance-identifier-invalid"]);

    const predicateOnLeaf = validateDataTree(schema, instance(
      `<refs xmlns="urn:refs" xmlns:r="urn:refs"><positional>/r:refs/r:item[r:name='a']/r:name[.='a']</positional></refs>`));
    expect(predicateOnLeaf.issues.map(item => item.code)).toEqual(["instance-identifier-invalid"]);

    const missingPosition = validateDataTree(schema, instance(
      `<refs xmlns="urn:refs" xmlns:r="urn:refs"><positional>/r:refs/r:unkeyed[3]</positional><unkeyed><value>a</value></unkeyed><unkeyed><value>b</value></unkeyed></refs>`));
    expect(missingPosition.issues.map(item => item.code)).toEqual(["instance-identifier-dangling"]);

    const invalidPosition = validateDataTree(schema, instance(
      `<refs xmlns="urn:refs" xmlns:r="urn:refs"><positional>/r:refs/r:unkeyed[0]</positional></refs>`));
    expect(invalidPosition.issues.map(item => item.code)).toEqual(["instance-identifier-invalid"]);

    const incompatiblePredicates = validateDataTree(schema, instance(
      `<refs xmlns="urn:refs" xmlns:r="urn:refs"><positional>/r:refs/r:unkeyed[1][r:value='a']</positional></refs>`));
    expect(incompatiblePredicates.issues.map(item => item.code)).toEqual(["instance-identifier-invalid"]);

    const unquotedKeyValue = validateDataTree(schema, instance(
      `<refs xmlns="urn:refs" xmlns:r="urn:refs"><positional>/r:refs/r:item[r:name=a]</positional></refs>`));
    expect(unquotedKeyValue.issues.map(item => item.code)).toEqual(["instance-identifier-invalid"]);
  });

  it("resolves instance-identifiers across top-level roots in a datastore wrapper", async () => {
    const schema = await compileModule(`module roots {
      namespace "urn:roots"; prefix r;
      container alpha { leaf target { type instance-identifier; } }
      container beta { leaf value { type string; } }
    }`);
    const verdict = validateDataTree(schema, instance(
      `<data xmlns="urn:transport" xmlns:r="urn:roots"><r:alpha><r:target>/r:beta/r:value</r:target></r:alpha><r:beta><r:value>present</r:value></r:beta></data>`));
    expect(verdict).toMatchObject({ status: "valid", issues: [] });
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
