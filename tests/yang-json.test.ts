import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { compileYangModules, parseYang, resolveModuleSet, validateDataTree } from "../src/index.js";
import { documentToYangJson, yangJsonToDocument, YangJsonError, schemaNodeForElement } from "../src/internal.js";
import { parseXml } from "./dom.js";

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
    leaf idref { type identityref { base x-kind; } }
    leaf iid { type instance-identifier; }
    leaf emp { type empty; }
    leaf-list tags { type string; }
    list items { key k; leaf k { type string; } leaf v { type uint32; } }
  }
  identity x-kind;
  identity x-sub { base x-kind; }
}`;

const AUX = `module aux {
  namespace "urn:aux"; prefix aux;
  import probe { prefix p; }
  augment "/p:top" {
    container extra { leaf note { type string; } }
  }
}`;

async function compile() {
  const set = await resolveModuleSet([parseYang(PROBE), parseYang(AUX)], { async loadModule() { return undefined; } });
  const schema = compileYangModules(set);
  expect(schema.diagnostics).toEqual([]);
  return schema;
}

const emptyDoc = (): Document =>
  new DOMParser().parseFromString("<placeholder/>", "application/xml") as unknown as Document;

const BODY = {
  "probe:top": {
    i8: 7,
    i64: "1234567890123",
    dec: "7.25",
    b: true,
    bits: "a b",
    idref: "probe:x-sub",
    iid: "/probe:top/probe:i8",
    emp: [null],
    tags: ["one", "two"],
    items: [
      { k: "first", v: 1 },
      { k: "second", v: 2 },
    ],
    "aux:extra": { note: "augmented" },
  },
};

describe("RFC 7951 JSON adapter", () => {
  it("decodes a RESTCONF JSON body into an instance document the validator accepts", async () => {
    const schema = await compile();
    const doc = yangJsonToDocument(schema, BODY, { document: emptyDoc() });
    expect(doc.documentElement.namespaceURI).toBe("urn:probe");
    expect(doc.documentElement.localName).toBe("top");
    // i64/dec keep their string form as XML text; i8 arrives too.
    const i64 = doc.getElementsByTagNameNS("urn:probe", "i64")[0]!;
    expect(i64.textContent).toBe("1234567890123");
    const dec = doc.getElementsByTagNameNS("urn:probe", "dec")[0]!;
    expect(dec.textContent).toBe("7.25");
    const i8 = doc.getElementsByTagNameNS("urn:probe", "i8")[0]!;
    expect(i8.textContent).toBe("7");
    // empty stays an empty element.
    const emp = doc.getElementsByTagNameNS("urn:probe", "emp")[0]!;
    expect(emp.childNodes.length).toBe(0);
    const iid = doc.getElementsByTagNameNS("urn:probe", "iid")[0]!;
    expect(iid.textContent).toBe("/p:top/p:i8");
    expect(iid.lookupNamespaceURI("p")).toBe("urn:probe");
    // list entries become sibling elements; leaf-lists repeat.
    expect(doc.getElementsByTagNameNS("urn:probe", "items").length).toBe(2);
    expect(doc.getElementsByTagNameNS("urn:probe", "tags").length).toBe(2);
    // The namespace-changing augment child carries the augmenting module's namespace.
    const extra = doc.getElementsByTagNameNS("urn:aux", "extra")[0]!;
    expect(extra.namespaceURI).toBe("urn:aux");
    // End-to-end: the existing validator accepts the produced document.
    const verdict = validateDataTree(schema, doc);
    expect(verdict).toMatchObject({ status: "valid", issues: [] });
  });

  it("rejects malformed bodies with a locator", async () => {
    const schema = await compile();
    expect(() => yangJsonToDocument(schema, "no", { document: emptyDoc() })).toThrow(YangJsonError);
    expect(() => yangJsonToDocument(schema, { "probe:top": {}, "probe:other": {} }, { document: emptyDoc() })).toThrow(/top-level/);
    expect(() => yangJsonToDocument(schema, { "probe:unknown": {} }, { document: emptyDoc() })).toThrow(YangJsonError);
    expect(() => yangJsonToDocument(schema, { "probe:top": { items: { k: "x" } } }, { document: emptyDoc() })).toThrow(/items/);
  });

  it("encodes an instance document back to an RFC 7951 body", async () => {
    const schema = await compile();
    const xml = parseXml(
      `<top xmlns="urn:probe" xmlns:aux2="urn:aux">
         <i8>7</i8>
         <i64>1234567890123</i64>
         <dec>7.25</dec>
         <b>true</b>
         <bits>a b</bits>
         <idref xmlns:x="urn:probe">x:x-sub</idref>
         <iid>/probe:top/probe:i8</iid>
         <emp/>
         <tags>one</tags><tags>two</tags>
         <items><k>first</k><v>1</v></items>
         <items><k>second</k><v>2</v></items>
         <aux2:extra><aux2:note>augmented</aux2:note></aux2:extra>
       </top>`,
    );
    const body = documentToYangJson(schema, xml);
    expect(Object.keys(body)).toEqual(["probe:top"]);
    const top = body["probe:top"] as Record<string, unknown>;
    expect(top.i8).toBe(7);
    expect(top.i64).toBe("1234567890123");
    expect(top.dec).toBe("7.25");
    expect(top.b).toBe(true);
    expect(top.bits).toBe("a b");
    // identityref re-qualifies with the module defining the identity.
    expect(top.idref).toBe("probe:x-sub");
    expect(top.emp).toEqual([null]);
    expect(top.tags).toEqual(["one", "two"]);
    expect(top.items).toEqual([{ k: "first", v: 1 }, { k: "second", v: 2 }]);
    // namespace change → module-qualified member name.
    expect(top["aux:extra"]).toEqual({ note: "augmented" });
    // iid values survive as strings (local-name matching stays the documented limitation).
    expect(top.iid).toBe("/probe:top/probe:i8");
  });

  it("round trips: JSON → document → JSON is the identity", async () => {
    const schema = await compile();
    const doc = yangJsonToDocument(schema, BODY, { document: emptyDoc() });
    const back = documentToYangJson(schema, doc);
    expect(back).toEqual(BODY);
  });

  it("keeps schema identity: schema lookups work on generated documents", async () => {
    const schema = await compile();
    const doc = yangJsonToDocument(schema, BODY, { document: emptyDoc() });
    const topNode = schemaNodeForElement(schema, doc.documentElement)!;
    expect(topNode.name).toBe("top");
    expect(topNode.children.length).toBeGreaterThan(5);
    const items = doc.getElementsByTagNameNS("urn:probe", "items")[0]!;
    const listEntry = schemaNodeForElement(schema, items as Element)!;
    expect(listEntry.kind).toBe("list");
  });
});
