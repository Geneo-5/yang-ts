import { describe, expect, it } from "vitest";
import {
  canonicalFormOf, childOf, compileYangModules, createFormModel, evaluateCandidates, moduleNamespacePrefixes,
  parseYang, resolveModuleSet, validateFormValue, validateDataTree, YangSyntaxError,
} from "../src/index.js";
import type { CompiledSchemaNode, CompiledYangSchema } from "../src/index.js";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const xml = (text: string) => new DOMParser().parseFromString(text, "application/xml");

/** Builds a module wrapping the given inner statements. */
const wrap = (inner: string, indent = "        ") => `module sample {\n${indent}namespace "urn:sample";\n${indent}prefix s;\n${indent}${inner}\n}`;

const statementOf = (source: string, keyword: string) => {
  const module = parseYang(wrap(source));
  const found = childOf(module, keyword);
  if (!found) throw new Error(`Statement ${keyword} not found in test source`);
  return found;
};

describe("Stage 7 P1 – submodule compile context (RFC 7950 §5.6.2)", () => {
  const ownerYang = `module owner {
    yang-version 1.1;
    namespace "urn:owner";
    prefix own;
    import dep { prefix dp; }
    include parts;
    leaf flagged { type boolean; }
  }`;
  const depYang = `module dep {
    yang-version 1.1;
    namespace "urn:dep";
    prefix d;
    typedef dep-type { type string; }
    grouping dep-grouping { container dep-container; }
  }`;
  const submoduleYang = `submodule parts {
    yang-version 1.1;
    belongs-to owner { prefix op; }
    import dep { prefix sp; }
    container parts-root {
      leaf typed-leaf { type sp:dep-type; }
      uses sp:dep-grouping;
      leaf conditional {
        type string;
        when "op:flagged = 'true'";
      }
    }
    augment "/op:parts-root" {
      container extra;
      leaf extra-leaf { type sp:dep-type; }
    }
  }`;

  const compileSet: Promise<CompiledYangSchema> = (async () => {
    const resolved = await resolveModuleSet([parseYang(ownerYang), parseYang(depYang)], {
      async loadSubmodule() { return parseYang(submoduleYang); },
    });
    return compileYangModules(resolved);
  })();

  const rootOf = async (name: string): Promise<CompiledSchemaNode> => {
    const schema = await compileSet;
    const root = schema.roots.find(node => node.name === name);
    if (!root) throw new Error(`Root '${name}' not found`);
    return root;
  };
  const childAt = (node: CompiledSchemaNode, name: string): CompiledSchemaNode => {
    const child = node.children.find(candidate => candidate.name === name);
    if (!child) throw new Error(`Child '${name}' not found under ${node.path}`);
    return child;
  };

  it("compiles submodule data nodes in the parent module namespace", async () => {
    const schema = await compileSet;
    expect(schema.diagnostics).toEqual([]);
    expect((await rootOf("parts-root")).module).toBe("owner");
  });

  it("resolves types declared only in the submodule's own imports", async () => {
    const schema = await compileSet;
    expect(schema.diagnostics).toEqual([]);
    expect(childAt(await rootOf("parts-root"), "typed-leaf").resolvedType).toBe("string");
    expect(childAt(await rootOf("parts-root"), "extra-leaf").resolvedType).toBe("string");
  });

  it("expands a uses referencing a grouping through the submodule's imports", async () => {
    const schema = await compileSet;
    expect(schema.diagnostics).toEqual([]);
    const root = await rootOf("parts-root");
    expect(() => childAt(root, "dep-container")).not.toThrow();
  });

  it("resolves XPath prefixes declared by the module and its submodules", async () => {
    const schema = await compileSet;
    expect(moduleNamespacePrefixes(schema, "owner")).toMatchObject({
      own: "urn:owner",
      dp: "urn:dep",
      op: "urn:owner",
      sp: "urn:dep",
    });
  });
});

describe("Stage 7 P1 – parser string tokens (RFC 7950 §6.1.3)", () => {
  it("accepts quoted arguments whose value is a delimiter", () => {
    expect(statementOf(`default ";";`, "default")?.argument).toBe(";");
    expect(statementOf(`default "{";`, "default")?.argument).toBe("{");
    expect(statementOf(`default '}';`, "default")?.argument).toBe("}");
  });

  it("transforms escaped characters in double-quoted strings", () => {
    expect(statementOf(`description "a\\nb";`, "description")?.argument).toBe("a\nb");
    expect(statementOf(`description "a\\tb";`, "description")?.argument).toBe("a\tb");
    expect(statementOf(`description "a\\"b";`, "description")?.argument).toBe('a"b');
    expect(statementOf(`description "a\\\\b";`, "description")?.argument).toBe("a\\b");
  });

  it("rejects a backslash followed by any other character", () => {
    expect(() => parseYang(wrap(`description "a\\qb";`))).toThrow(YangSyntaxError);
    expect(() => parseYang(wrap(`description "trailing \\";`))).toThrow(YangSyntaxError);
  });

  it("preserves the backslash inside single-quoted strings", () => {
    expect(statementOf(`description '\\n';`, "description")?.argument).toBe("\\n");
  });

  it("strips indentation and trailing whitespace of multi-line double-quoted strings", () => {
    // RFC 7950 §6.1.3.1: stripping is bounded by the column of the opening
    // quote (column 9 here), so this equals "first line" + newline + two spaces.
    const statement = statementOf(
      `description\n        "first line\n           second line";`,
      "description",
    );
    expect(statement?.argument).toBe("first line\n  second line");
  });

  it("strips trailing whitespace before every line break", () => {
    const statement = statementOf(`description "a   \n        b";`, "description");
    expect(statement?.argument).toBe("a\nb");
  });

  it("leaves single-quoted strings untouched, raw line breaks included", () => {
    const statement = statementOf(`description 'a   \n        b';`, "description");
    expect(statement?.argument).toBe("a   \n        b");
  });

  it("keeps an empty string argument distinguishable from no argument", () => {
    const stmt = statementOf(`leaf e { type string; default ""; }`, "leaf");
    const loc = childOf(stmt, "default");
    expect(loc).toBeDefined();
    expect(loc!.argument).toBe("");
  });

  it("rejects adjacent quoted strings without a plus sign", () => {
    expect(() => parseYang(wrap(`description "a" "b";`))).toThrow(YangSyntaxError);
    expect(() => parseYang(wrap(`default "a" 'b';`))).toThrow(YangSyntaxError);
    expect(() => parseYang(wrap(`default 'a' b;`))).toThrow(YangSyntaxError);
    expect(() => parseYang(wrap(`default a 'b';`))).toThrow(YangSyntaxError);
  });

  it("still joins unquoted word arguments with single spaces (key lists)", () => {
    const stmt = statementOf(`key a b c;`, "key");
    expect(stmt?.argument).toBe("a b c");
  });

  it("reports end-of-input errors at the end of the source", () => {
    const captures = (source: string, line: number) => {
      try {
        parseYang(source);
      } catch (error) {
        if (!(error instanceof YangSyntaxError)) throw error;
        expect(error.location).toMatchObject({ line });
        return;
      }
      throw new Error(`parseYang did not fail on: ${JSON.stringify(source)}`);
    };
    captures("module m;\nleaf\n", 2); // "Expected ';' or '{'" must report end-of-input, not the keyword
    captures("module m {\n", 2); // "Expected statement keyword" must report end-of-input
  });

  it("guards against pathological statement nesting", () => {
    let nested = `container depth0 { }`;
    for (let depth = 1; depth < 300; depth++) nested = `container depth${depth} { ${nested} }`;
    expect(() => parseYang(wrap(nested))).toThrow(/nesting/i);
  });
});

describe("Stage 7 P1 – validation over the accessible tree", () => {
  const compileData = async (model: string) => {
    const resolved = await resolveModuleSet([parseYang(model)], { async loadModule() { return undefined; } });
    const schema = compileYangModules(resolved);
    expect(schema.diagnostics).toEqual([]);
    return schema;
  };

  const defaultsModel = `module defaults {
    namespace "urn:defaults"; prefix d;
    container box {
      leaf mode { type enumeration { enum auto; enum manual; } default auto; }
      leaf mode-ref { type leafref { path "../mode"; } }
      must "mode = 'auto'";
    }
  }`;

  it("injects declared defaults into must and leafref evaluation", async () => {
    const schema = await compileData(defaultsModel);
    // `mode` is absent: with-defaults content makes the must true and the
    // leafref value 'auto' resolvable (RFC 7950 §7.6.1, §6.4.1).
    const result = validateDataTree(schema, xml(
      `<box xmlns="urn:defaults"><mode-ref>auto</mode-ref></box>`,
    ));
    expect(result).toMatchObject({ status: "valid", issues: [] });
    // An explicit non-default value keeps the must unmet and… the mode-ref leafref (mode=manual value) no longer resolves.
    const contradicted = validateDataTree(schema, xml(
      `<box xmlns="urn:defaults"><mode>manual</mode><mode-ref>manual</mode-ref></box>`,
    ));
    expect(contradicted.status).toBe("invalid");
    expect(contradicted.issues.map(issue => issue.code)).toEqual(["must-unmet"]);
  });

  const stateModel = `module flagged {
    namespace "urn:flagged"; prefix f;
    container box {
      leaf name { type string; }
      container state {
        config false;
        leaf oper-status { type string; mandatory true; }
      }
    }
  }`;

  it("hides config false state data when validating the config datastore", async () => {
    const schema = await compileData(stateModel);
    const configOnly = validateDataTree(schema, xml(
      `<box xmlns="urn:flagged"><name>x</name></box>`,
    ), { includeState: false });
    expect(configOnly).toMatchObject({ status: "valid", issues: [] });
    // State data participating again when validating the operational datastore.
    const withState = validateDataTree(schema, xml(
      `<box xmlns="urn:flagged"><name>x</name><state/></box>`,
    ), { includeState: true });
    expect(withState.issues.map(issue => issue.code)).toEqual(["missing-mandatory"]);
  });

  it("does not mutate the caller's document while probing when-gated nodes", async () => {
    const model = `module gated {
      namespace "urn:gated"; prefix g;
      container box {
        leaf flag { type boolean; when "../name = 'y'"; }
        leaf name { type string; }
      }
    }`;
    const schema = await compileData(model);
    const document = xml(`<box xmlns="urn:gated"><name>x</name></box>`);
    const before = Array.from(document.documentElement!.childNodes).map(child => child.nodeName).sort().join(",");
    validateDataTree(schema, document);
    const after = Array.from(document.documentElement!.childNodes).map(child => child.nodeName).sort().join(",");
    expect(after).toBe(before);
  });
});

describe("Stage 7 P1 – form restrictions descriptor and cross references", () => {
  const compileOne = async (text: string) => {
    const resolved = await resolveModuleSet([parseYang(text)], { async loadModule() { return undefined; } });
    const schema = compileYangModules(resolved);
    expect(schema.diagnostics).toEqual([]);
    return schema;
  };

  it("keeps type restrictions through copied fields via a serializable descriptor", async () => {
    const schema = await compileOne(`module forms {
      namespace "urn:forms"; prefix f;
      container box {
        leaf code { type int32 { range "0..100"; } }
        leaf code-name { type string { length "1..3"; pattern "[a-z]+"; } }
        leaf precision { type decimal64 { fraction-digits 1; } }
      }
    }`);
    const model = createFormModel(parseYang(`module forms {
      namespace "urn:forms"; prefix f;
      container box {
        leaf code { type int32 { range "0..100"; } }
        leaf code-name { type string { length "1..3"; pattern "[a-z]+"; } }
        leaf precision { type decimal64 { fraction-digits 1; } }
      }
    }`));
    const box = model.fields.filter(field => field.path.startsWith("/box/"));
    expect(box.length).toBe(3);
    const [code, codeName, precision] = box;
    expect(() => JSON.stringify(code.restrictions)).not.toThrow();
    // A shallow copy must not silently lose range/length/pattern/digits.
    expect(validateFormValue({ ...code! }, 300).status).toBe("invalid");
    expect(validateFormValue({ ...codeName! }, "abcd").status).toBe("invalid");
    expect(validateFormValue({ ...codeName! }, "ABC").status).toBe("invalid");
    expect(canonicalFormOf({ ...precision! }, "3.1")).toBe("3.1");
    void schema;
  });

  it("strips [*] from form paths so list-entry leafrefs cross-reference", async () => {
    const source = `module forms {
      namespace "urn:forms"; prefix f;
      container devices {
        list device {
          key name;
          leaf name { type string; }
          leaf peer { type leafref { path "../name"; } }
        }
      }
    }`;
    const resolved = await resolveModuleSet([parseYang(source)], { async loadModule() { return undefined; } });
    const schema = compileYangModules(resolved);
    const model = createFormModel(parseYang(source));
    const peer = model.fields.find(field => field.path === "/devices/device[*]/peer");
    expect(peer).toBeDefined();
    const document = new DOMParser().parseFromString(
      `<devices xmlns="urn:forms"><device><name>a</name></device></devices>`, "application/xml");
    // Leafref paths evaluate from the field's own node, so probe with a
    // placeholder `peer` element inside the list entry it would occupy.
    const entry = Array.from(document.getElementsByTagNameNS("urn:forms", "device"))[0]!;
    const anchor = document.createElement("peer");
    entry.appendChild(anchor);
    const context = { schema, anchor };
    expect(validateFormValue(peer!, "a", context).status).toBe("valid");
    const dangling = validateFormValue(peer!, "zz", context);
    expect(dangling.status).toBe("invalid");
    expect(dangling.errors.map(error => error.code)).toEqual(["constraint.leafref"]);
  });

  it("validates leaf-list cross-reference values entry by entry", async () => {
    const source = `module forms {
      namespace "urn:forms"; prefix f;
      container devices {
        list device {
          key name;
          leaf name { type string; }
          leaf-list peers { type leafref { path "/f:devices/device/name"; } }
        }
      }
    }`;
    const resolved = await resolveModuleSet([parseYang(source)], { async loadModule() { return undefined; } });
    const schema = compileYangModules(resolved);
    const model = createFormModel(parseYang(source));
    const peers = model.fields.find(field => field.path === "/devices/device[*]/peers");
    expect(peers).toBeDefined();
    const document = new DOMParser().parseFromString(
      `<devices xmlns="urn:forms"><device><name>a</name><peers>a</peers></device></devices>`, "application/xml");
    const anchor = Array.from(document.getElementsByTagNameNS("urn:forms", "device"))[0]!;
    const context = { schema, anchor };
    expect(validateFormValue(peers!, ["a"], context).status).toBe("valid");
    const dangling = validateFormValue(peers!, ["a", "zz"], context);
    expect(dangling.status).toBe("invalid");
    expect(dangling.errors.map(error => error.code)).toEqual(["constraint.leafref"]);
  });

  it("validates union leaf-lists member by member instead of staying indeterminate", async () => {
    const source = `module forms {
      namespace "urn:forms"; prefix f;
      container box {
        leaf-list mixed { type union { type int32; type string { length "1..2"; } } }
      }
    }`;
    const model = createFormModel(parseYang(source));
    const mixed = model.fields.find(field => field.path === "/box/mixed")!;
    expect(mixed.restrictions.unionMembers?.length).toBe(2);
    expect(validateFormValue(mixed, ["7", "ab"])).toMatchObject({ status: "valid", errors: [] });
    const rejected = validateFormValue(mixed, ["toolong"]);
    expect(rejected.status).toBe("invalid");
  });
});

describe("Stage 7 P1 – evaluateCandidates", () => {
  const moduleSet = async (...sources: string[]) => compileYangModules(
    await resolveModuleSet(sources.map(parseYang), { async loadModule() { return undefined; } }));

  it("locates targets under choice/case segments and augmented (foreign) namespaces", async () => {
    const schema = await moduleSet(
      `module alpha {
        namespace "urn:alpha"; prefix a;
        container top {
          choice transport {
            case raw { leaf raw-size { type enumeration { enum small; enum big; } } }
          }
        }
      }`,
      `module beta {
        namespace "urn:beta"; prefix b;
        import alpha { prefix a; }
        augment "/a:top" {
          container box { leaf mode { type enumeration { enum on; enum off; } } }
        }
      }`,
    );
    expect(schema.diagnostics).toEqual([]);
    // A <data> wrapper keeps the document element out of the target path, and
    // the augmented `box` subtree lives in beta's namespace, not alpha's.
    const document = xml(`<data><top xmlns="urn:alpha"><raw-size>small</raw-size><box xmlns="urn:beta"><mode>on</mode></box></top></data>`);
    const mode = evaluateCandidates(schema, document, "/top/box/mode");
    expect(mode.domain).toBe("enum");
    expect(mode.candidates.map(candidate => candidate.status)).toEqual(["allowed", "allowed"]);
    const size = evaluateCandidates(schema, document, "/top/transport/raw/raw-size");
    expect(size.domain).toBe("enum");
    expect(size.candidates.map(candidate => candidate.status)).toEqual(["allowed", "allowed"]);
  });

  it("targets a specific list entry through key predicates", async () => {
    const schema = await moduleSet(`module probe {
      namespace "urn:probe"; prefix p;
      container relay {
        list upstream {
          key name;
          must "name = 'core'";
          leaf name { type string; }
          leaf status { type enumeration { enum up; enum down; } }
        }
      }
    }`);
    const document = xml(`<relay xmlns="urn:probe">
      <upstream><name>core</name><status>up</status></upstream>
      <upstream><name>edge</name><status>down</status></upstream>
    </relay>`);
    const core = evaluateCandidates(schema, document, "/relay/upstream[name='core']/status");
    expect(core.candidates.map(candidate => candidate.status)).toEqual(["allowed", "allowed"]);
    const edge = evaluateCandidates(schema, document, "/relay/upstream[name='edge']/status");
    expect(edge.candidates.map(candidate => candidate.status)).toEqual(["blocked", "blocked"]);
    expect(edge.candidates[0]!.reasons.map(reason => reason.code)).toEqual(["must-unmet"]);
  });

  it("never mutates the caller's document (probe and content both restored)", async () => {
    const schema = await moduleSet(`module probe {
      namespace "urn:probe"; prefix p;
      container session { leaf echo { type enumeration { enum ping; enum discard; } must "../transport = 'tcp' or . = 'discard'"; } }
    }`);
    // `ping` violates the must (no transport sibling), `discard` satisfies it.
    const document = xml(`<session xmlns="urn:probe"><echo/></session>`);
    const before = new XMLSerializer().serializeToString(document);
    const evaluated = evaluateCandidates(schema, document, "/session/echo");
    expect(evaluated.candidates.map(candidate => candidate.status)).toEqual(["blocked", "allowed"]);
    // An empty element (no text) previously kept the last candidate value.
    expect(new XMLSerializer().serializeToString(document)).toBe(before);
  });

  it("honors ancestor and sibling constraints that depend on the node", async () => {
    const schema = await moduleSet(`module probe {
      namespace "urn:probe"; prefix p;
      container eval {
        must "mode = 'on'";
        leaf mode { type enumeration { enum on; enum off; } }
        leaf checked { type string; must "../mode = 'on'"; }
      }
    }`);
    const document = xml(`<eval xmlns="urn:probe"><mode>on</mode><checked>x</checked></eval>`);
    const candidates = evaluateCandidates(schema, document, "/eval/mode");
    expect(candidates.candidates.find(candidate => candidate.value === "on")?.status).toBe("allowed");
    const off = candidates.candidates.find(candidate => candidate.value === "off")!;
    expect(off.status).toBe("blocked");
    expect(off.reasons.map(reason => reason.code)).toEqual(["must-unmet", "must-unmet"]);
  });
});

describe("Stage 7 P1 – refine, uses augment and symbol scoping (RFC 7950 §7.13, §6.2.1)", () => {
  const moduleSet = async (...sources: string[]) => compileYangModules(
    await resolveModuleSet(sources.map(parseYang), { async loadModule() { return undefined; } }));
  const moduleSetWithSubmodules = async (submodules: readonly string[], ...sources: string[]) => compileYangModules(
    await resolveModuleSet(sources.map(parseYang), {
      async loadModule() { return undefined; },
      async loadSubmodule() { return parseYang(submodules[0] ?? ""); },
    }));

  it("refines a leaf's mandatory statement (§7.13.2)", async () => {
    const schema = await moduleSet(`module probe {
      namespace "urn:probe"; prefix p;
      grouping endpoint { leaf address { type string; } }
      container services {
        uses endpoint { refine address { mandatory true; } }
      }
      container unchecked { uses endpoint; }
    }`);
    expect(schema.diagnostics.filter(diagnostics => diagnostics.code === "invalid-refine")).toEqual([]);
    const document = xml(`<services xmlns="urn:probe"><other/></services>`);
    const result = validateDataTree(schema, document);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "missing-mandatory", path: "/services/address",
    }));
    const unrefined = validateDataTree(schema, xml(`<unchecked xmlns="urn:probe"/>`));
    expect(unrefined.issues.filter(issue => issue.code === "missing-mandatory")).toEqual([]);
  });

  it("expands an augment declared inside uses", async () => {
    const schema = await moduleSet(`module probe {
      namespace "urn:probe"; prefix p;
      grouping base {
        container tunnel { leaf name { type string; } }
      }
      container services {
        uses base {
          augment "tunnel" {
            leaf color { type enumeration { enum red; enum blue; } }
          }
        }
      }
    }`);
    expect(schema.diagnostics.filter(diagnostics => diagnostics.code === "unresolved-augment")).toEqual([]);
    const color = schema.roots[0]!.children.find(node => node.name === "tunnel")
      ?.children.find(node => node.name === "color");
    expect(color?.namespace).toBe("urn:probe");
    expect(color?.resolvedType).toBe("enumeration");
  });

  it("keeps grouping-scoped symbols out of sibling scopes and lets locals shadow top level", async () => {
    const source = parseYang(`module probe {
      namespace "urn:probe"; prefix p;
      typedef width { type int8; }
      grouping box {
        typedef width { type int32; }
        grouping hidden { container secret; }
        leaf span { type width { range "300"; } }
      }
      container svc { uses box; }
      container misuse { uses hidden; }
    }`);
    const schema = compileYangModules(
      await resolveModuleSet([source], { async loadModule() { return undefined; } }));
    const nestedWidth = source.children.find(child => child.keyword === "grouping" && child.argument === "box")!
      .children.find(child => child.keyword === "typedef" && child.argument === "width")!;
    // scoping: `uses hidden` outside its grouping is NOT visible from `svc`…
    expect(schema.diagnostics.some(diagnostics =>
      diagnostics.code === "unresolved-grouping" && diagnostics.message.includes("hidden") === true)).toBe(true);
    // …the span leaf resolves `width` to the grouping-local int32 typedef (a
    // range of 300 only validates for int32), and not the top-level int8.
    const span = schema.roots[0]!.children.find(node => node.name === "span")!;
    expect(span.typedefChain[0]).toBe(nestedWidth);
    expect(schema.diagnostics.some(diagnostics => diagnostics.code === "invalid-type-restriction")).toBe(false);
  });

  it("resolves a grouping's internal prefixes in its declaring submodule document", async () => {
    const schema = await moduleSetWithSubmodules(
      [`submodule parts {
        belongs-to fam { prefix f; }
        import net { prefix n; }
        grouping endpoint { leaf addr { type n:address; } }
      }`],
      `module fam {
        namespace "urn:fam"; prefix f;
        include parts;
        container host { uses endpoint; }
      }`,
      `module net {
        namespace "urn:net"; prefix n;
        typedef address { type string; }
      }`,
    );
    expect(schema.diagnostics.filter(diagnostics => diagnostics.code === "unresolved-type")).toEqual([]);
    const addr = schema.roots[0]!.children.find(node => node.name === "addr");
    expect(addr?.resolvedType).toBe("string");
  });
});

describe("Stage 7 P1 – identityref XML prefixes and enum-value by node type", () => {
  const compileOne = async (source: string) => compileYangModules(
    await resolveModuleSet([parseYang(source)], { async loadModule() { return undefined; } }));

  it("returns NaN for non-enumeration nodes and the node's own enum position otherwise", async () => {
    const schema = await compileOne(`module mux {
      namespace "urn:mux"; prefix m;
      container alarm {
        leaf severity { type enumeration { enum cleared { value 1; } enum minor { value 3; } enum major { value 5; } } }
        // The same enum name with a different value elsewhere in the schema
        // must not swing the result: nodes decide, not a schema-wide table.
        leaf ambient { type enumeration { enum major { value 0; } } }
        must "enum-value(severity) >= 5";
      }
    }`);
    expect(schema.diagnostics).toEqual([]);
    const major = validateDataTree(schema, xml(`<alarm xmlns="urn:mux"><severity>major</severity><ambient>major</ambient></alarm>`));
    expect(major.status).toBe("valid");
    const minor = validateDataTree(schema, xml(`<alarm xmlns="urn:mux"><severity>minor</severity><ambient>major</ambient></alarm>`));
    expect(minor.status).toBe("invalid");
    expect(minor.issues.some(issue => issue.code === "must-unmet")).toBe(true);
  });

  it("resolves identityref values through XML namespace prefixes in derived-from", async () => {
    const schema = await compileOne(`module routing {
      namespace "urn:routing"; prefix r;
      identity tunnel-type;
      identity gre { base tunnel-type; }
      identity lisp { base tunnel-type; }
      container topo {
        leaf gateway {
          type identityref { base tunnel-type; }
          must "derived-from(., 'tunnel-type')";
        }
      }
    }`);
    expect(schema.diagnostics).toEqual([]);
    // XML prefix bound to the identity's module namespace (RFC 7950 §9.10.4).
    const qualified = validateDataTree(schema, xml(
      `<topo xmlns="urn:routing" xmlns:g="urn:routing"><gateway>g:gre</gateway></topo>`));
    expect(qualified.status).toBe("valid");
    // A prefix bound to a foreign namespace is not a routable identity.
    const foreign = validateDataTree(schema, xml(
      `<topo xmlns="urn:routing" xmlns:z="urn:zeta"><gateway>z:gre</gateway></topo>`));
    expect(foreign.status).toBe("invalid");
    // Module-name-qualified and plain values keep working.
    expect(validateDataTree(schema, xml(
      `<topo xmlns="urn:routing"><gateway>routing:gre</gateway></topo>`)).status).toBe("valid");
    expect(validateDataTree(schema, xml(
      `<topo xmlns="urn:routing"><gateway>gre</gateway></topo>`)).status).toBe("valid");
  });

  it("resolves XML-prefixed identityref form values through the anchor element", async () => {
    const schema = await compileOne(`module routing {
      namespace "urn:routing"; prefix r;
      identity tunnel-type;
      identity gre { base tunnel-type; }
      container topo {
        leaf gateway { type identityref { base tunnel-type; } }
      }
    }`);
    expect(schema.diagnostics).toEqual([]);
    const formModel = createFormModel(parseYang(`module routing {
      namespace "urn:routing"; prefix r;
      identity tunnel-type;
      identity gre { base tunnel-type; }
      container topo {
        leaf gateway { type identityref { base tunnel-type; } }
      }
    }`));
    const gateway = formModel.fields.find(field => field.path === "/topo/gateway")!;
    const settings = xml(`<topo xmlns="urn:routing" xmlns:x="urn:routing" xmlns:z="urn:zeta"/>`);
    const anchor = settings.createElement("gateway");
    settings.documentElement!.appendChild(anchor);
    const context = { schema, anchor };
    // XML prefix bound to the identity's module resolves to routing:gre.
    expect(validateFormValue(gateway, "x:gre", context).status).toBe("valid");
    // Module-qualified and plain values keep working.
    expect(validateFormValue(gateway, "routing:gre", context).status).toBe("valid");
    expect(validateFormValue(gateway, "gre", context).status).toBe("valid");
    // A prefix bound to a namespace outside the schema is not the identity.
    expect(validateFormValue(gateway, "z:gre", context).status).toBe("invalid");
  });
});
