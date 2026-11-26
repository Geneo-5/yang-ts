import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseYang } from "../src/index.js";
import { childOf, childrenOf } from "../src/internal.js";

const fixtures = new URL("./fixtures/yang/", import.meta.url);
function load(path: string) {
  return parseYang(readFileSync(fileURLToPath(new URL(path, fixtures)), "utf8"));
}
function descendants(node: ReturnType<typeof parseYang>): Array<{ keyword: string; argument?: string }> {
  const result: Array<{ keyword: string; argument?: string }> = [];
  const visit = (parent: { children: Array<{ keyword: string; argument?: string; children: unknown[] }> }) => {
    for (const child of parent.children) {
      result.push(child);
      visit(child as typeof parent);
    }
  };
  visit(node);
  return result;
}

describe("upstream YANG fixtures", () => {
  it("parses the small Sysrepo oven model and its user-facing constructs", () => {
    const oven = load("sysrepo/oven.yang");
    expect(oven.argument).toBe("oven");
    expect(childrenOf(oven, "typedef").map(node => node.argument)).toContain("oven-temperature");
    expect(childrenOf(oven, "rpc").map(node => node.argument)).toEqual(["insert-food", "remove-food"]);
    expect(childrenOf(oven, "notification").map(node => node.argument)).toContain("oven-ready");
    expect(childrenOf(oven, "container").map(node => node.argument)).toEqual(["oven", "oven-state"]);
  });

  it("parses the RFC 8343 module and its RFC 8344 augment dependency closure", () => {
    const interfaces = load("standard/ietf/RFC/ietf-interfaces@2018-02-20.yang");
    const ip = load("standard/ietf/RFC/ietf-ip@2018-02-22.yang");
    const inetTypes = load("standard/ietf/RFC/ietf-inet-types@2013-07-15.yang");
    const yangTypes = load("standard/ietf/RFC/ietf-yang-types@2013-07-15.yang");

    expect(interfaces.argument).toBe("ietf-interfaces");
    expect(childOf(interfaces, "yang-version")?.argument).toBe("1.1");
    expect(childrenOf(interfaces, "import").map(node => node.argument)).toContain("ietf-yang-types");
    expect(childrenOf(ip, "import").map(node => node.argument)).toEqual([
      "ietf-interfaces", "ietf-inet-types", "ietf-yang-types",
    ]);
    expect(childrenOf(ip, "augment").map(node => node.argument)).toEqual([
      "/if:interfaces/if:interface", "/if:interfaces-state/if:interface",
    ]);
    expect(inetTypes.argument).toBe("ietf-inet-types");
    expect(yangTypes.argument).toBe("ietf-yang-types");
  });

  it("parses RFC 8343 extension modules with if:type-dependent when statements", () => {
    const extensions = load("standard/ietf/draft/ietf-if-extensions@2025-08-07.yang");
    const ethernetLike = load("standard/ietf/draft/ietf-if-ethernet-like@2025-08-07.yang");
    const ianaIfType = load("standard/iana/iana-if-type@2023-01-26.yang");

    expect(extensions.argument).toBe("ietf-if-extensions");
    expect(ethernetLike.argument).toBe("ietf-if-ethernet-like");
    expect(ianaIfType.argument).toBe("iana-if-type");
    expect(childrenOf(extensions, "import").map(node => node.argument)).toEqual([
      "ietf-yang-types", "ietf-interfaces", "iana-if-type",
    ]);
    expect(childrenOf(ethernetLike, "import").map(node => node.argument)).toEqual([
      "ietf-interfaces", "ietf-yang-types", "iana-if-type",
    ]);

    const extensionAugments = childrenOf(extensions, "augment");
    expect(extensionAugments).toHaveLength(4);
    expect(extensionAugments.map(node => node.argument)).toEqual([
      "/if:interfaces/if:interface",
      "/if:interfaces/if:interface",
      "/if:interfaces/if:interface/if:statistics",
      "/if:interfaces/if:interface/if:statistics",
    ]);
    expect(childrenOf(ethernetLike, "augment").map(node => node.argument)).toEqual([
      "/if:interfaces/if:interface",
      "/if:interfaces/if:interface/if:statistics",
    ]);

    for (const module of [extensions, ethernetLike]) {
      expect(descendants(module).some(node => node.keyword === "when" && node.argument?.includes("if:type"))).toBe(true);
    }
  });
});
