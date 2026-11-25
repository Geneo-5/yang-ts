import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import {
  buildAccessibleTree, compileYangModules, parseYang, resolveModuleSet,
} from "../src/index.js";
import type { CompiledYangSchema } from "../src/index.js";

// Stage 7 P0 regressions: wrong "valid" answers or wrong namespaces.
// Each test mirrors a ROADMAP.md Stage 7 finding.

const loaderNone = { async loadModule() { return undefined; } };

async function compile(source: string, extra: string[] = []): Promise<CompiledYangSchema> {
  const modules = [parseYang(source), ...extra.map(text => parseYang(text))];
  return compileYangModules(await resolveModuleSet(modules, loaderNone));
}

const xml = (text: string) => new DOMParser().parseFromString(text, "application/xml");

describe("stage 7 P0 correctness regressions", () => {
  it("resolves a module's own prefix in must/when XPath expressions", async () => {
    const schema = await compile(`module oven {
      namespace "urn:oven"; prefix ov;
      container oven {
        leaf turned-on { type boolean; default false; }
        leaf temperature {
          type uint8 { range "0..250"; }
          must "/ov:oven/ov:turned-on = 'true'" { error-message "the oven must be on"; }
        }
      }
    }`);
    const evaluator = (await import("../src/index.js")).createConstraintEvaluator(schema);
    const instance = (inner: string) => xml(`<oven xmlns="urn:oven">${inner}</oven>`);
    const tree = (root: Element) =>
      buildAccessibleTree(schema, root.ownerDocument ?? root, { context: "datastore-state" })
        .document.getElementsByTagName("oven")[0]!;

    const on = tree(instance("<turned-on>true</turned-on><temperature>180</temperature>").documentElement);
    expect(evaluator.evaluateNode(on.getElementsByTagName("temperature")[0]!))
      .toMatchObject([{ kind: "must", status: "met" }]);

    const off = tree(instance("<turned-on>false</turned-on><temperature>180</temperature>").documentElement);
    expect(evaluator.evaluateNode(off.getElementsByTagName("temperature")[0]!))
      .toMatchObject([{ kind: "must", status: "unmet" }]);
  });

  it("checks leafrefs declared through a typedef, not only inline leafref types", async () => {
    // Regression for the review finding: resolveLeafref read `path` from the
    // node's own `type` only, so `type if:interface-ref` vectors were never
    // validated and dangled references were silently valid.
    const schema = await compile(`module ifref {
      namespace "urn:ifref"; prefix i;
      typedef interface-ref { type leafref { path "/i:interfaces/i:interface/i:name"; } }
      container interfaces {
        list interface { key name; leaf name { type string; } }
        leaf link { type interface-ref; }
      }
    }`);
    const { validateDataTree } = await import("../src/index.js");
    const doc = (link: string) => xml(`<interfaces xmlns="urn:ifref">
      <interface><name>eth0</name></interface>
      <link>${link}</link>
    </interfaces>`);

    expect(validateDataTree(schema, doc("eth0")).status).toBe("valid");
    const dangling = validateDataTree(schema, doc("eth9"));
    expect(dangling.issues).toContainEqual(expect.objectContaining({
      code: "leafref-dangling", path: "/interfaces/link" satisfies string,
    }));
  });

  it("validates nodes under choice/case: must, mandatory-on-active-case", async () => {
    const schema = await compile(`module mux {
      namespace "urn:mux"; prefix m;
      container mux {
        choice transport {
          case udp {
            leaf port {
              type uint16;
              must "current() < 1024" { error-message "privileged ports only"; }
            }
            leaf verify { type boolean; mandatory true; }
          }
          case unix {
            leaf path { type string; }
          }
        }
      }
    }`);
    const { validateDataTree } = await import("../src/index.js");
    const doc = (inner: string) => xml(`<mux xmlns="urn:mux">${inner}</mux>`);

    // (a) must on a case member leaf is enforced when the case is active.
    // The compiled node.path still carries the choice/case segments; data-path
    // normalization for evaluateCandidates is tracked as a Stage 7 P1 item.
    const mustViolation = validateDataTree(schema, doc("<port>8080</port><verify>true</verify>"));
    expect(mustViolation.issues).toContainEqual(expect.objectContaining({
      code: "must-unmet", path: "/mux/transport/udp/port",
    }));
    // (b) mandatory leaf absent in an active case is an error.
    const missingInActive = validateDataTree(schema, doc("<unix><path>/tmp</path></unix>"));
    expect(missingInActive.issues).toEqual([]);
    const activeMissingVerify = validateDataTree(schema, doc("<port>80</port>"));
    expect(activeMissingVerify.issues).toContainEqual(expect.objectContaining({
      code: "missing-mandatory", path: "/mux/transport/udp/verify",
    }));
  });

  it("applies RFC 7950 unique semantics: multi-step and prefixed paths, absent-leaf exclusion", async () => {
    const schema = await compile(`module uniq {
      namespace "urn:uniq"; prefix u;
      container net {
        list provision {
          key name;
          leaf name { type string; }
          container data { leaf ip { type string; } }
          unique "data/ip";
          unique "u:data/ip";
        }
      }
    }`);
    const { validateDataTree } = await import("../src/index.js");
    const doc = (entries: string) => xml(`<net xmlns="urn:uniq">${entries}</net>`);

    // Multi-step path (own-prefixed form included): distinct values are fine.
    // The old check matched local names only, so both paths collapsed to empty
    // signatures and reported false unique-violations.
    const distinct = validateDataTree(schema, doc(`
      <provision><name>p1</name><data><ip>10.0.0.1</ip></data></provision>
      <provision><name>p2</name><data><ip>10.0.0.2</ip></data></provision>
    `));
    expect(distinct.issues).toEqual([]);

    const collision = validateDataTree(schema, doc(`
      <provision><name>p1</name><data><ip>10.0.0.1</ip></data></provision>
      <provision><name>p2</name><data><ip>10.0.0.1</ip></data></provision>
    `));
    expect(collision.issues.filter(issue => issue.code === "unique-violation")).toHaveLength(2); // both unique statements

    // RFC 7950 section 7.8.3: entries missing any referenced leaf are excluded.
    const missingExcluded = validateDataTree(schema, doc(`
      <provision><name>p1</name></provision>
      <provision><name>p2</name></provision>
    `));
    expect(missingExcluded.issues.filter(issue => issue.code === "unique-violation")).toEqual([]);
  });

  it("assigns grouping-instantiated descendants to the instantiating module", async () => {
    const schema = await compile(`module user {
      namespace "urn:user"; prefix usr;
      import lib { prefix lib; }
      container box {
        uses lib:shared-list;
      }
    }`, [`module lib {
      namespace "urn:lib"; prefix lb;
      grouping shared-list {
        list item {
          key name;
          leaf name { type string; }
          container detail { leaf note { type string; } }
        }
      }
    }`]);
    expect(schema.diagnostics, schema.diagnostics.map(d => `${d.code}: ${d.message}`)).toEqual([]);

    const list = schema.roots.find(root => root.name === "box")!.children.find(child => child.name === "item")!;
    expect(list.module).toBe("user");
    expect(list.namespace).toBe("urn:user");
    // Nested descendants — several levels under the grouping — are user nodes.
    const detail = list.children.find(child => child.name === "detail")!;
    expect(detail.module).toBe("user");
    expect(detail.namespace).toBe("urn:user");
    expect(detail.children.find(child => child.name === "note")!.namespace).toBe("urn:user");
    // The list key resolves against the same namespace (used to report a
    // false invalid-key because the key leaf kept the defining module).
    expect(list.children.some(child => child.kind === "leaf" && child.name === "name")).toBe(true);
  });

  it("treats invert-match patterns as inverted and XSD/JS divergent patterns as pending", async () => {
    const { parseYang, createFormModel, validateFormValue } = await import("../src/index.js");
    const moduleYaml = parseYang(`module pat {
      namespace "urn:pat"; prefix p;
      container pat {
        leaf forbidden {
          type string { pattern "bad" { modifier invert-match; } }
        }
        leaf digits {
          // XSD \\d is Unicode-wide and JS \\d is ASCII-only; the engine cannot
          // know the instance charset, so evaluation must stay indeterminate.
          type string { pattern "[\\\\d]{3}"; }
        }
        leaf unicode-class {
          type string { pattern "\\\\p{Lu}+"; }
        }
        leaf anchored {
          // ^/$ are anchors in JS but ordinary characters in XSD.
          type string { pattern "^ab$"; }
        }
      }
    }`);
    const form = createFormModel(moduleYaml);
    const field = (name: string) => form.fields.find(candidate => candidate.path === `/pat/${name}`)!;

    // invert-match: the forbidden value must NOT be accepted and passing
    // values must not be rejected as they used to be.
    const matching = validateFormValue(field("forbidden"), "bad");
    expect(matching.status).toBe("invalid");
    const inverted = validateFormValue(field("forbidden"), "good");
    expect(inverted.errors).toEqual([]);
    expect(inverted.status).toBe("valid");

    for (const name of ["digits", "unicode-class", "anchored"]) {
      const result = validateFormValue(field(name), name === "digits" ? "42" : "abc");
      expect(result.status, `${name} must stay unjudged, not silently validated`).toBe("indeterminate");
      expect(result.pending.some(item => item.kind === "unsupported")).toBe(true);
    }
  });
});
