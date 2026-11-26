import { describe, expect, it } from "vitest";
import {
  compileYangModules,
  createConstraintEvaluator,
  evaluateCandidates,
  parseYang,
  resolveModuleSet,
  validateDataTree,
} from "../src/index.js";
import { documentNamespace } from "../src/internal.js";
import {
  COMPILED_SCHEMA_FORMAT,
  COMPILED_SCHEMA_VERSION,
  CompiledSchemaFormatError,
  deserializeCompiledSchema,
  serializeCompiledSchema,
} from "../src/yang/serialization.js";
import { parseXml } from "./dom.js";

const FACTORY = `module factory {
  namespace "urn:factory"; prefix f;
  feature hal;
  identity pump-kind;
  identity pump-speed { base pump-kind; }
  typedef pct { type uint8 { range "0..100"; } }
  grouping meta { leaf note { type string; } }
  container line {
    leaf transport { type enumeration { enum tcp; enum udp; } }
    list unit {
      key id;
      leaf id { type string; }
      leaf rate { type pct; must "../rate > 0"; when "../../control/enabled = 'true'"; }
      leaf flags { type bits { bit run; bit err; } }
      leaf kind { type identityref { base pump-kind; } }
      choice mode {
        case manual { leaf dial { type pct; } }
        case auto { leaf target { type pct; } }
      }
    }
  }
  container control { leaf enabled { type boolean; default true; } }
  container info { uses meta { refine note { mandatory true; } } }
  rpc drain { input { leaf force { type boolean; } } output { leaf drained { type uint32; } } }
  notification alarm { leaf code { type string; } }
}`;

const BASE = `module base {
  namespace "urn:base"; prefix b;
  include ext;
  container hub { leaf id { type string; } }
}`;

const EXT = `submodule ext {
  belongs-to base { prefix b; }
  augment "/b:hub" { leaf extra { type string; } }
}`;

async function compile(texts: string[]) {
  const set = await resolveModuleSet(texts.map(parseYang), { async loadModule() { return undefined; } });
  const schema = compileYangModules(set);
  expect(schema.diagnostics).toEqual([]);
  return schema;
}

/** Serialized → JSON text → parsed: the byte-level shape a browser would load. */
function asLoaded(schema: ReturnType<typeof compileYangModules>): unknown {
  return JSON.parse(JSON.stringify(serializeCompiledSchema(schema)));
}

function expectFormatError(payload: unknown, code: CompiledSchemaFormatError["code"], messagePart?: string) {
  try {
    deserializeCompiledSchema(payload);
  } catch (error) {
    expect(error).toBeInstanceOf(CompiledSchemaFormatError);
    expect((error as CompiledSchemaFormatError).code).toBe(code);
    if (messagePart) expect((error as CompiledSchemaFormatError).message).toContain(messagePart);
    return;
  }
  throw new Error(`expected a ${code} deserialization error`);
}

describe("compiled schema serialization", () => {
  it("emits the versioned envelope and is stable across a JSON round trip", async () => {
    const schema = await compile([FACTORY]);
    const payload = serializeCompiledSchema(schema);
    expect(COMPILED_SCHEMA_VERSION).toBe(1);
    expect(payload.version).toBe(COMPILED_SCHEMA_VERSION);
    expect(payload.format).toBe(COMPILED_SCHEMA_FORMAT);
    const again = JSON.parse(JSON.stringify(serializeCompiledSchema(deserializeCompiledSchema(asLoaded(schema)))));
    expect(again).toEqual(payload);
  });

  it("deserializes an equal schema, source locations included", async () => {
    const schema = await compile([FACTORY]);
    const revived = deserializeCompiledSchema(asLoaded(schema));
    expect(revived).toEqual(schema);
    const unit = revived.roots[0]!.children.find(node => node.name === "unit")!;
    const rate = unit.children.find(node => node.name === "rate")!;
    expect(rate.source.location.line).toBeGreaterThan(0);
    expect(unit.keys).toEqual(["id"]);
    expect(unit.children.map(child => child.name)).toContain("mode");
    expect(revived.operations.map(operation => `${operation.kind}:${operation.name}`)).toEqual(["rpc:drain", "notification:alarm"]);
    expect(revived.identities.map(identity => identity.name)).toEqual(["pump-kind", "pump-speed"]);
  });

  it("survives cross-document compilation: submodule augment and per-document namespaces", async () => {
    const set = await resolveModuleSet([parseYang(BASE)], {
      async loadModule() { return undefined; },
      async loadSubmodule(name) { return name === "ext" ? parseYang(EXT) : undefined; },
    });
    const schema = compileYangModules(set);
    expect(schema.diagnostics).toEqual([]);
    const revived = deserializeCompiledSchema(asLoaded(schema));
    expect(revived).toEqual(schema);
    const extra = revived.roots[0]!.children.find(node => node.name === "extra")!;
    expect(extra.declaredIn).toBe("ext");
    // RFC 7950 6.4.1: the submodule's expressions (its own prefixes) resolve
    // exactly as before the round trip.
    expect(documentNamespace(revived, "ext")).toBe(documentNamespace(schema, "ext"));
  });

  it("lets every engine consumer operate on the revived schema", async () => {
    const schema = await compile([FACTORY]);
    const revived = deserializeCompiledSchema(asLoaded(schema));
    // Range violation: rate 150 is outside its inherited pct range.
    const outOfRange = parseXml(
      `<line xmlns="urn:factory"><control><enabled>true</enabled></control>` +
      `<transport>tcp</transport><unit><id>u1</id><rate>150</rate></unit></line>`,
    );
    expect(validateDataTree(revived, outOfRange).status).toBe("invalid");
    // must failure: rate 0 satisfies the range but breaks `../rate > 0`...
    const mustFailure = parseXml(
      `<line xmlns="urn:factory"><control><enabled>true</enabled></control>` +
      `<transport>tcp</transport><unit><id>u1</id><rate>0</rate></unit></line>`,
    );
    const result = validateDataTree(revived, mustFailure);
    expect(result.status).toBe("invalid");
    expect(result.issues.length).toBeGreaterThan(0);
    // ...and the must evaluation itself is reachable with its source statement.
    const rateElement = mustFailure.getElementsByTagNameNS("urn:factory", "rate")[0]!;
    const evaluations = createConstraintEvaluator(revived).evaluateNode(rateElement);
    const must = evaluations.find(evaluation => evaluation.kind === "must")!;
    expect(must.status).toBe("unmet");
    expect(must.expression).toBe("../rate > 0");
    const originalMust = createConstraintEvaluator(schema).evaluateNode(rateElement).find(evaluation => evaluation.kind === "must")!;
    expect(must.status).toBe(originalMust.status);
    expect(must.source).toEqual(originalMust.source);
    // Candidates and enumeration domains also run on the revived graph.
    const candidates = evaluateCandidates(revived, mustFailure, "/line/transport");
    expect(candidates.candidates.map(candidate => candidate.status)).toEqual(["allowed", "allowed"]);
  });

  it("refuses payloads that are not the format, the version, or the shape", async () => {
    const schema = await compile([FACTORY]);
    const payload = serializeCompiledSchema(schema);
    expectFormatError(null, "format");
    expectFormatError(undefined, "format");
    expectFormatError(42, "format");
    expectFormatError([], "format");
    expectFormatError({}, "format");
    expectFormatError({ ...payload, format: "someone-else/schema" }, "format", COMPILED_SCHEMA_FORMAT);
    expectFormatError({ ...payload, version: 999 }, "version", "999");
    expectFormatError({ format: COMPILED_SCHEMA_FORMAT, version: COMPILED_SCHEMA_VERSION }, "structure");
    expectFormatError({ ...payload, schema: { ...payload.schema, roots: "nope" } }, "structure");
    expectFormatError(
      { ...payload, schema: { ...payload.schema, roots: [{ ...payload.schema.roots[0]!, kind: "widget" }] } },
      "structure",
    );
    expectFormatError(
      {
        ...payload,
        schema: { ...payload.schema, roots: [{ ...payload.schema.roots[0]!, children: undefined }] },
      },
      "structure",
    );
    // Version mismatch names both numbers so callers can react (ROADMAP 191).
    try {
      deserializeCompiledSchema({ ...payload, version: COMPILED_SCHEMA_VERSION + 1 });
      throw new Error("expected a version error");
    } catch (error) {
      expect((error as CompiledSchemaFormatError).message).toContain(String(COMPILED_SCHEMA_VERSION));
    }
  });

  it("refuses to emit values no JSON file can carry", async () => {
    const schema = await compile([FACTORY]);
    const broken = JSON.parse(JSON.stringify(serializeCompiledSchema(schema)));
    broken.schema.roots[0].poison = () => "boom";
    try {
      serializeCompiledSchema(broken.schema as never);
      throw new Error("expected an unsupported-value error");
    } catch (error) {
      expect(error).toBeInstanceOf(CompiledSchemaFormatError);
      expect((error as CompiledSchemaFormatError).code).toBe("unsupported-value");
    }
    const withDom = JSON.parse(JSON.stringify(serializeCompiledSchema(schema)));
    withDom.schema.roots[0].dom = parseXml("<x/>");
    try {
      serializeCompiledSchema(withDom.schema as never);
      throw new Error("expected an unsupported-value error for the DOM node");
    } catch (error) {
      expect(error).toBeInstanceOf(CompiledSchemaFormatError);
      expect((error as CompiledSchemaFormatError).code).toBe("unsupported-value");
    }
  });
});
