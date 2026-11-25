import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { compileYangModules, evaluateCandidates, finiteDomainOf, parseYang, resolveModuleSet } from "../src/index.js";

const instance = (xml: string) => new DOMParser().parseFromString(xml, "application/xml");

async function compileModule(text: string) {
  const schema = compileYangModules(await resolveModuleSet([parseYang(text)], { async loadModule() { return undefined; } }));
  expect(schema.diagnostics).toEqual([]);
  return schema;
}

describe("contextual candidate evaluation", () => {
  it("filters enum candidates against the surrounding data (end-to-end)", async () => {
    const schema = await compileModule(`module probe {
      namespace "urn:probe"; prefix p;
      container session {
        leaf transport {
          type enumeration { enum tcp; enum udp; }
        }
        leaf echo {
          type enumeration { enum ping; enum discard; }
          must "../transport = 'tcp' or . = 'discard'";
        }
      }
    }`);
    const find = (path: string) => schema.roots[0]!.children.find(node => node.name === path)!;
    expect(finiteDomainOf(find("echo"))).toEqual({ domain: "enum", values: ["ping", "discard"] });

    const withTcp = evaluateCandidates(schema, instance(
      `<session xmlns="urn:probe"><transport>tcp</transport><echo>ping</echo></session>`), "/session/echo");
    expect(withTcp.candidates.map(candidate => candidate.status)).toEqual(["allowed", "allowed"]);

    const withUdp = evaluateCandidates(schema, instance(
      `<session xmlns="urn:probe"><transport>udp</transport><echo>ping</echo></session>`), "/session/echo");
    const ping = withUdp.candidates.find(candidate => candidate.value === "ping")!;
    expect(ping.status).toBe("blocked");
    expect(ping.reasons[0]!.code).toBe("must-unmet");
    expect(ping.reasons[0]!.source.keyword).toBe("must");
    expect(withUdp.candidates.find(candidate => candidate.value === "discard")!.status).toBe("allowed");
  });

  it("narrows enum candidates through typedef restrictions", async () => {
    const schema = await compileModule(`module kinds {
      namespace "urn:kinds"; prefix k;
      typedef base-mode { type enumeration { enum auto; enum manual; enum hybrid; } }
      typedef half-mode { type base-mode { enum manual; enum hybrid; } }
      container gear {
        leaf mode { type half-mode { enum manual; } }
      }
    }`);
    expect(finiteDomainOf(schema.roots[0]!.children[0]!)).toEqual({ domain: "enum", values: ["manual"] });
  });

  it("probes when-gated absent leaves with each candidate", async () => {
    const schema = await compileModule(`module gated {
      namespace "urn:gated"; prefix g;
      leaf active { type boolean; }
      leaf frequency {
        when "../active = 'true'";
        type enumeration { enum slow; enum fast; }
      }
    }`);
    const off = evaluateCandidates(schema, instance(
      `<gated xmlns="urn:gated"><active>false</active></gated>`), "/frequency");
    expect(off.candidates.map(candidate => candidate.status)).toEqual(["blocked", "blocked"]);
    expect(off.candidates[0]!.reasons[0]!.code).toBe("when-unmet");

    const on = evaluateCandidates(schema, instance(
      `<gated xmlns="urn:gated"><active>true</active></gated>`), "/frequency");
    expect(on.candidates.map(candidate => candidate.status)).toEqual(["allowed", "allowed"]);
  });

  it("toggles bits candidates into the requested selection", async () => {
    const schema = await compileModule(`module flags {
      namespace "urn:flags"; prefix f;
      container feature {
        leaf mask {
          type bits { bit alpha; bit beta; }
          must "not(contains(., 'alpha')) or ../enabled = 'true'";
        }
        leaf enabled { type boolean; }
      }
    }`);
    const result = evaluateCandidates(schema, instance(
      `<feature xmlns="urn:flags"><mask></mask><enabled>true</enabled></feature>`),
      "/feature/mask", { bitsSelection: ["beta"] });
    expect(result.domain).toBe("bits");
    expect(result.candidates.map(candidate => candidate.value)).toEqual(["alpha", "beta"]);
    expect(result.candidates.map(candidate => candidate.status)).toEqual(["allowed", "allowed"]);

    const disabled = evaluateCandidates(schema, instance(
      `<feature xmlns="urn:flags"><mask></mask><enabled>false</enabled></feature>`),
      "/feature/mask", { bitsSelection: ["beta"] });
    const alpha = disabled.candidates.find(candidate => candidate.value === "alpha")!;
    expect(alpha.status).toBe("blocked");
    expect(alpha.reasons[0]!.code).toBe("must-unmet");
    // The probe value was restored after evaluation.
    expect(alpha.reasons[0]!.source.keyword).toBe("must");
  });

  it("keeps candidates indeterminate when a must cannot be evaluated", async () => {
    const schema = await compileModule(`module unsure {
      namespace "urn:unsure"; prefix u;
      leaf level {
        type enumeration { enum low; enum high; }
        must "does-not-exist(.)";
      }
    }`);
    const result = evaluateCandidates(schema, instance(
      `<level xmlns="urn:unsure">low</level>`), "/level");
    expect(result.candidates.map(candidate => candidate.status)).toEqual(["indeterminate", "indeterminate"]);
    expect(result.candidates[0]!.reasons[0]!.code).toBe("constraint-indeterminate");
  });

  it("reports a boolean domain and an empty result for other types", async () => {
    const schema = await compileModule(`module plain {
      namespace "urn:plain"; prefix p;
      leaf on { type boolean; }
      leaf name { type string; }
      container box { leaf inner { type string; } }
    }`);
    const on = evaluateCandidates(schema, instance(`<on xmlns="urn:plain">true</on>`), "/on");
    expect(on.domain).toBe("boolean");
    expect(on.candidates.map(candidate => candidate.value)).toEqual(["true", "false"]);
    expect(evaluateCandidates(schema, instance(`<name xmlns="urn:plain">x</name>`), "/name").domain).toBe("none");
    expect(evaluateCandidates(schema, instance(`<box xmlns="urn:plain"/>`), "/box/missing").domain).toBe("none");
  });
});
