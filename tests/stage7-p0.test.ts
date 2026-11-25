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
});
