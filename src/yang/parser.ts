import { YangModule, YangStatement, YangSyntaxError } from "./ast.js";

type Token = { value: string; offset: number; line: number; column: number; kind: "word" | "string" | "symbol" };

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0, line = 1, column = 1;
  const advance = (text: string) => { for (const c of text) { if (c === "\n") { line++; column = 1; } else column++; } i += text.length; };
  while (i < input.length) {
    const c = input[i]!;
    if (/\s/.test(c)) { advance(c); continue; }
    if (input.startsWith("//", i)) { const end = input.indexOf("\n", i); advance(input.slice(i, end < 0 ? input.length : end)); continue; }
    if (input.startsWith("/*", i)) { const end = input.indexOf("*/", i + 2); if (end < 0) throw new YangSyntaxError("Unterminated comment", { offset: i, line, column }); advance(input.slice(i, end + 2)); continue; }
    const start = { offset: i, line, column };
    if (c === "'" || c === '"') {
      const quote = c; advance(c); let value = "";
      while (i < input.length && input[i] !== quote) {
        if (quote === '"' && input[i] === "\\" && i + 1 < input.length) { advance(input[i]!); value += input[i]!; advance(input[i]!); }
        else { value += input[i]!; advance(input[i]!); }
      }
      if (input[i] !== quote) throw new YangSyntaxError("Unterminated string", start);
      advance(quote); out.push({ ...start, value, kind: "string" }); continue;
    }
    if ("{};".includes(c)) { out.push({ ...start, value: c, kind: "symbol" }); advance(c); continue; }
    let value = "";
    while (i < input.length && !/\s/.test(input[i]!) && !"{};'\"".includes(input[i]!) && !input.startsWith("//", i) && !input.startsWith("/*", i)) { value += input[i]!; advance(input[i]!); }
    if (!value) throw new YangSyntaxError(`Unexpected character '${c}'`, start);
    out.push({ ...start, value, kind: "word" });
  }
  return out;
}

/** Parses the YANG statement grammar into a source-located generic AST. */
export function parseYang(source: string): YangModule {
  const tokens = tokenize(source); let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];
  function statement(): YangStatement {
    const key = take();
    if (!key || key.kind !== "word") throw new YangSyntaxError("Expected statement keyword", key ?? { offset: source.length, line: 1, column: 1 });
    const argumentParts: Array<{ value: string; kind: Token["kind"] }> = [];
    while (peek() && peek()!.value !== ";" && peek()!.value !== "{") {
      const part = take()!;
      if (part.kind === "symbol") throw new YangSyntaxError("Unexpected symbol in statement argument", part);
      argumentParts.push({ value: part.value, kind: part.kind });
    }
    // RFC 7950 permits adjacent quoted strings joined by '+'. The plus is
    // concatenation syntax and is not part of the resulting argument value.
    let argument = "";
    for (let i = 0; i < argumentParts.length; i++) {
      const part = argumentParts[i]!;
      if (part.value === "+" && part.kind === "word") continue;
      let value = part.value;
      while (part.kind === "string" && argumentParts[i + 1]?.value === "+" && argumentParts[i + 2]?.kind === "string") {
        value += argumentParts[i + 2]!.value;
        i += 2;
      }
      argument += (argument ? " " : "") + value;
    }
    const end = take();
    if (!end || (end.value !== ";" && end.value !== "{")) throw new YangSyntaxError("Expected ';' or '{'", end ?? key);
    const children: YangStatement[] = [];
    if (end.value === "{") {
      while (peek() && peek()!.value !== "}") children.push(statement());
      const close = take();
      if (!close) throw new YangSyntaxError("Unterminated statement block", key);
    }
    return { keyword: key.value, ...(argument ? { argument } : {}), children, location: { offset: key.offset, line: key.line, column: key.column } };
  }
  const root = statement();
  if (peek()) throw new YangSyntaxError("Unexpected content after module", peek()!);
  if (root.keyword !== "module" && root.keyword !== "submodule") throw new YangSyntaxError("Expected module or submodule", root.location);
  if (!root.argument) throw new YangSyntaxError("Module name is required", root.location);
  return root as YangModule;
}

export function childrenOf(node: YangStatement, keyword: string): YangStatement[] { return node.children.filter(child => child.keyword === keyword); }
export function childOf(node: YangStatement, keyword: string): YangStatement | undefined { return node.children.find(child => child.keyword === keyword); }
