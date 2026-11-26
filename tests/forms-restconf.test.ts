import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import {
  compileYangModules,
  createRestconfGetRequest,
  createRestconfRpcRequest,
  documentToYangJson,
  formInputToRestconfBody,
  formPathToYangPathSegments,
  formValuesToRestconfBody,
  nodeToRestconfDataPath,
  parseYang,
  resolveModuleSet,
  validateDataTree,
  yangJsonToDocument,
} from "../src/index.js";
import { createFormModel } from "../src/index.js";
import type { FormModel } from "../src/forms/form-model.js";

const PROBE = `module probe {
  namespace "urn:probe"; prefix p;
  typedef my-int { type int64; }
  typedef my-dec { type decimal64 { fraction-digits 2; } }
  container top {
    leaf i8 { type int8; }
    leaf i64 { type my-int; }
    leaf dec { type my-dec; }
    leaf b { type boolean; }
    leaf bits { type bits { bit a; bit b; } }
    leaf emp { type empty; }
    leaf-list tags { type string; }
    list items { key k; leaf k { type string; } leaf v { type uint32; } }
  }
}`;

const OVEN = `module oven {
  namespace "urn:oven"; prefix o;
  rpc insert-food {
    input {
      leaf time { type uint32; }
      leaf kind { type string; }
    }
  }
}`;

async function probeModel(): Promise<FormModel> {
  const set = await resolveModuleSet([parseYang(PROBE)], { async loadModule() { return undefined; } });
  expect(set.diagnostics).toEqual([]);
  return createFormModel(parseYang(PROBE));
}

async function ovenModel(): Promise<FormModel> {
  return createFormModel(parseYang(OVEN));
}

const emptyDoc = (): Document =>
  new DOMParser().parseFromString("<placeholder/>", "application/xml") as unknown as Document;

describe("form values → RESTCONF bodies (§195)", () => {
  it("encodes scalars with the RFC 7951 conventions shared with documentToYangJson", async () => {
    const model = await probeModel();
    const body = formValuesToRestconfBody(model, {
      "/top/i8": 7,
      "/top/i64": "1234567890123",
      "/top/dec": "7.25",
      "/top/b": "true",
      "/top/bits": ["a", "b"],
      "/top/emp": true,
      "/top/tags": ["one", "two"],
    });
    expect(body).toEqual({
      "probe:top": {
        i8: 7,
        i64: "1234567890123",
        dec: "7.25",
        b: true,
        bits: "a b",
        emp: [null],
        tags: ["one", "two"],
      },
    });
    // Values absent from the map are omitted, never defaulted.
    const partial = formValuesToRestconfBody(model, { "/top/i8": 7 });
    expect(partial).toEqual({ "probe:top": { i8: 7 } });
  });

  it("expands list entries from ordered value records", async () => {
    const model = await probeModel();
    const body = formValuesToRestconfBody(model, {
      "/top/items[*]": [
        { "/top/items[*]/k": "first", "/top/items[*]/v": 1 },
        { "/top/items[*]/k": "second", "/top/items[*]/v": 2 },
      ],
    });
    expect(body).toEqual({
      "probe:top": {
        items: [
          { k: "first", v: 1 },
          { k: "second", v: 2 },
        ],
      },
    });
  });

  it("round trips form values through JSON ↔ document and validates", async () => {
    const model = await probeModel();
    const set = await resolveModuleSet([parseYang(PROBE)], { async loadModule() { return undefined; } });
    const schema = compileYangModules(set);
    expect(schema.diagnostics).toEqual([]);
    const values = {
      "/top/i8": 7,
      "/top/i64": "1234567890123",
      "/top/b": true,
      "/top/bits": ["a", "b"],
      "/top/emp": true,
      "/top/tags": ["one", "two"],
      "/top/items[*]": [{ "/top/items[*]/k": "first", "/top/items[*]/v": 1 }],
    };
    const body = formValuesToRestconfBody(model, values);
    const document = yangJsonToDocument(schema, body, { document: emptyDoc() });
    const result = validateDataTree(schema, document);
    expect(result.status).toBe("valid");
    expect(result.issues).toEqual([]);
    expect(documentToYangJson(schema, document)).toEqual(body);
  });

  it("builds the RPC input body the createRestconfRpcRequest wrapper expects", async () => {
    const model = await ovenModel();
    const operation = model.operations[0]!;
    const input = formInputToRestconfBody(operation, {
      "/insert-food/input/time": 1700,
      "/insert-food/input/kind": "bagel",
    });
    expect(input).toEqual({ time: 1700, kind: "bagel" });
    const request = createRestconfRpcRequest(operation, input);
    expect(request.body).toEqual({ "oven:input": { time: 1700, kind: "bagel" } });
    expect(request.method).toBe("POST");
  });

  it("maps form paths to YangPathSegment paths that match the request builders", async () => {
    const segments = formPathToYangPathSegments("/top/items[*]/v", "probe", { listKeys: [{ k: "first" }] });
    expect(segments).toEqual([
      { name: "top", module: "probe" },
      { name: "items", module: "probe", keys: [{ name: "k", value: "first" }] },
      { name: "v", module: "probe" },
    ]);
    const listEntry = formPathToYangPathSegments("/top/items[*]", "probe", { listKeys: [{ k: "first" }] });
    expect(createRestconfGetRequest(listEntry).path).toBe(nodeToRestconfDataPath(segments.slice(0, 2)));
    const parent = formPathToYangPathSegments("/top/items[*]/", "probe", { listKeys: [{ k: "first" }] });
    expect(createRestconfGetRequest(parent).path).toBe(createRestconfGetRequest(listEntry).path);
    const leafList = formPathToYangPathSegments("/top/tags", "probe", { leafListValue: "one" });
    expect(leafList[leafList.length - 1]).toEqual({ name: "tags", module: "probe", leafListValue: "one" });
  });

  it("refuses list segments whose key values are missing", async () => {
    expect(() => formPathToYangPathSegments("/top/items[*]/v", "probe", { listKeys: [] })).toThrowError(/items/);
    expect(() => formPathToYangPathSegments("/top/items[*]/v", "probe")).toThrowError(/items/);
  });
});
