import { describe, expect, it } from "vitest";
import { childOf, parseYang, YangSyntaxError } from "../src/index.js";

/** Builds a module wrapping the given inner statements. */
const wrap = (inner: string, indent = "        ") => `module sample {\n${indent}namespace "urn:sample";\n${indent}prefix s;\n${indent}${inner}\n}`;

const statementOf = (source: string, keyword: string) => {
  const module = parseYang(wrap(source));
  const found = childOf(module, keyword);
  if (!found) throw new Error(`Statement ${keyword} not found in test source`);
  return found;
};

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
