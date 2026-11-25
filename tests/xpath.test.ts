import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { compileYangXPath, qualifyYangXPathNodeTests } from "../src/index.js";

describe("browser-compatible YANG XPath 1.0 adapter", () => {
  it("qualifies unprefixed node tests without changing functions, operators or literals", () => {
    expect(qualifyYangXPathNodeTests("count(item[@kind='item']) > 0 and child::item", "__yang_ns"))
      .toBe("count(__yang_ns:item[@kind='item']) > 0 and child::__yang_ns:item");
  });

  it("evaluates prefixed and current-module node tests with custom functions", () => {
    const document = new DOMParser().parseFromString(`<root xmlns="urn:base">
      <value>7</value><foreign xmlns="urn:other"><value>12</value></foreign>
    </root>`, "application/xml");
    const expression = compileYangXPath(
      "number(value) = 7 and count(other:foreign/other:value) = 1 and yang:is-positive(value)",
      "urn:base",
      { other: "urn:other", yang: "urn:yang:functions" },
    );
    expect(expression.qualifiedSource).toContain("__yang_ns:value");
    expect(expression.evaluateBoolean({
      node: document.documentElement,
      functions: {
        "is-positive": (_context, value) => Boolean(value && value.numberValue() > 0),
      },
    })).toBe(true);
  });

  it("keeps unprefixed names bound to the current module namespace", () => {
    const document = new DOMParser().parseFromString(`<root xmlns="urn:base"><value>1</value>
      <nested xmlns="urn:other"><value>2</value></nested>
    </root>`, "application/xml");
    const expression = compileYangXPath("count(value)", "urn:base");
    expect(expression.evaluateNumber({ node: document.documentElement })).toBe(1);
  });

  it("navigates a YANG-shaped data tree with list predicates and relative paths", () => {
    const document = new DOMParser().parseFromString(`<interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces">
      <interface><name>eth0</name><enabled>true</enabled></interface>
      <interface><name>eth1</name><enabled>false</enabled></interface>
    </interfaces>`, "application/xml");
    const xpath = compileYangXPath(
      "count(interface[enabled='true']) = 1 and string(interface[enabled='true']/name) = 'eth0'",
      "urn:ietf:params:xml:ns:yang:ietf-interfaces",
    );
    expect(xpath.evaluateBoolean({ node: document.documentElement })).toBe(true);
  });
});
