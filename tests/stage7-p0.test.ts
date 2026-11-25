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
});
