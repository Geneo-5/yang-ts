import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

/**
 * The test harness DOM bridge. The engine is typed against the browser DOM
 * (lib.dom); the Node test runtime provides @xmldom/xmldom, whose own type
 * declarations are not assignable to lib.dom. This is the one place where the
 * xmldom document is cast to the engine's DOM types — real browsers need no
 * bridge, everything else in the suites sees the engine's own types.
 */
export function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml") as unknown as Document;
}

/** Serialize a node through the same xmldom boundary as parseXml. */
export function serializeNode(node: Node): string {
  return new XMLSerializer().serializeToString(node as never);
}
