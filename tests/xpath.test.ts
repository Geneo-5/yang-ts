import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { compileYangModules, compileYangXPath, createYangFunctionLibrary, parseYang, qualifyYangXPathNodeTests, resolveModuleSet } from "../src/index.js";

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

  it("provides the RFC 7950 function library over a compiled schema", async () => {
    const types = parseYang(`module types {
      namespace "urn:types"; prefix t;
      identity interface-type;
      identity ethernetCsmacd { base interface-type; }
      identity subinterface { base interface-type; }
      typedef speed { type enumeration { enum auto { value 0; } enum ten { value 10; } enum hundred { value 100; } } }
      typedef flags { type bits { bit up; bit broadcast { position 2; } bit multicast; } }
      leaf type-ref { type identityref { base interface-type; } }
    }`);
    const interfaces = parseYang(`module interfaces {
      namespace "urn:if"; prefix i; import types { prefix t; }
      container interfaces {
        list interface { key name; leaf name { type string; } leaf type { type t:type-ref; } leaf speed { type t:speed; } leaf flags { type t:flags; } }
        leaf selected { type string; }
      }
    }`);
    const moduleSet = await resolveModuleSet([types, interfaces], { async loadModule() { return undefined; } });
    const compiled = compileYangModules(moduleSet);
    const module = interfaces;
    const library = createYangFunctionLibrary({ schema: compiled, module: module.argument, prefixModules: { t: "types", y: "types" } });

    const document = new DOMParser().parseFromString(`<interfaces xmlns="urn:if" xmlns:t="urn:types">
      <interface><name>eth0</name><type>types:ethernetCsmacd</type><speed>ten</speed><flags>up broadcast</flags></interface>
      <control>eth0</control>
    </interfaces>`, "application/xml");
    const root = document.documentElement!;
    const evaluate = (expression: string) => compileYangXPath(expression, "urn:if", {
      t: "urn:types", yang: "urn:ietf:params:xml:ns:yang:1",
    }).evaluateBoolean({ node: root, functions: library });

    // current() inside a predicate refers to the original context node.
    expect(evaluate("count(interface[name=current()/control]) = 1")).toBe(true);
    // re-match applies an implicitly-anchored XML Schema pattern.
    expect(evaluate("yang:re-match(interface/name, '[a-z]+[0-9]')")).toBe(true);
    expect(evaluate("yang:re-match(interface/name, '[a-z]+')")).toBe(false);
    // derived-from follows the identity hierarchy; derived-from-or-self includes the base itself.
    expect(evaluate("yang:derived-from(interface/type, 't:interface-type')")).toBe(true);
    expect(evaluate("yang:derived-from(interface/type, 't:subinterface')")).toBe(false);
    expect(evaluate("yang:derived-from(interface/type, 't:ethernetCsmacd')")).toBe(false);
    expect(evaluate("yang:derived-from-or-self(interface/type, 't:ethernetCsmacd')")).toBe(true);
    // enum-value resolves declared positions, including implicit numbering and bit positions.
    expect(evaluate("yang:enum-value(interface/speed) = 10")).toBe(true);
    expect(evaluate("yang:bit-is-set(interface/flags, 'broadcast') and yang:bit-is-set(interface/flags, 'up')")).toBe(true);
    expect(evaluate("yang:bit-is-set(interface/flags, 'multicast')")).toBe(false);
    // Unsupported patterns fail the expression instead of silently matching.
    expect(() => evaluate("yang:re-match(interface/name, '[a-z-[aeiou]]')")).toThrow();
  });
});
