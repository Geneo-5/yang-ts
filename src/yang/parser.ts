import { YangModule, YangStatement, YangSyntaxError } from "./ast.js";
import type { SourceLocation } from "./ast.js";

type Token = { value: string; offset: number; line: number; column: number; kind: "word" | "string" | "symbol" };

const MAX_STATEMENT_DEPTH = 200;

function tokenize(input: string): { tokens: Token[]; eof: SourceLocation } {
  const out: Token[] = [];
  let i = 0, line = 1, column = 1;
  const advance = (text: string) => { for (const c of text) { if (c === "\n") { line++; column = 1; } else column++; } i += text.length; };
  while (i < input.length) {
    const c = input[i]!;
    if (/\s/.test(c)) { advance(c); continue; }
    if (input.startsWith("//", i)) { const end = input.indexOf("\n", i); advance(input.slice(i, end < 0 ? input.length : end)); continue; }
    if (input.startsWith("/*", i)) { const end = input.indexOf("*/", i + 2); if (end < 0) throw new YangSyntaxError("Unterminated comment", { offset: i, line, column }); advance(input.slice(i, end + 2)); continue; }
    const start = { offset: i, line, column };
    if (c === "'") {
      // Single-quoted strings preserve every character (RFC 7950 §6.1.3).
      advance(c); let value = "";
      while (i < input.length && input[i] !== "'") { value += input[i]!; advance(input[i]!); }
      if (input[i] !== "'") throw new YangSyntaxError("Unterminated string", start);
      advance("'"); out.push({ ...start, value, kind: "string" }); continue;
    }
    if (c === '"') {
      // Double-quoted strings (RFC 7950 §6.1.3): trailing whitespace before
      // each line break and the indentation of continuation lines — up to and
      // including the column of the opening quote, tabs counting as 8 spaces —
      // are stripped first; backslash escapes are substituted afterwards.
      const openColumn = column;
      advance(c);
      let raw = "";
      let lineText = "";      // kept content of the current line
      let trailing = "";      // whitespace kept since the last non-whitespace char
      let sawNonWs = false;   // a non-whitespace char already occurs on this line
      let continuation = false; // at least one line break was consumed
      let contColumn = 1;     // column of the next char within its own line
      while (i < input.length && input[i] !== '"') {
        const ch = input[i]!;
        if (ch === "\n") {
          raw += lineText + "\n";
          lineText = ""; trailing = ""; sawNonWs = false; continuation = true; contColumn = 1;
          advance(ch); continue;
        }
        if (ch === "\\") {
          // Escapes are validated at scan time (they are value characters, not
          // whitespace, and must not terminate the string).
          const next = input[i + 1];
          if (next !== "n" && next !== "t" && next !== '"' && next !== "\\") {
            throw new YangSyntaxError(`The backslash must be followed by n, t, '"' or '\'`, { offset: i, line, column });
          }
          lineText += trailing + ch + next; trailing = ""; sawNonWs = true;
          advance(ch + next); continue;
        }
        const isWhitespace = /\s/.test(ch);
        if (isWhitespace && !sawNonWs && continuation) {
          // Examine the leading whitespace of a continuation line.
          if (contColumn <= openColumn) { contColumn += ch === "\t" ? 8 : 1; advance(ch); continue; }
        }
        if (isWhitespace) { trailing += ch; contColumn += ch === "\t" ? 8 : 1; advance(ch); continue; }
        lineText += trailing + ch; trailing = ""; sawNonWs = true; contColumn += 1; advance(ch);
      }
      raw += lineText + trailing; // closing-quote line keeps its trailing whitespace (only line breaks strip it)
      if (input[i] !== '"') throw new YangSyntaxError("Unterminated string", start);
      advance('"');
      // Escape substitution happens after trimming; concatenation is last.
      let value = "";
      for (let j = 0; j < raw.length; j++) {
        const ch = raw[j]!;
        if (ch !== "\\") { value += ch; continue; }
        const next = raw[j + 1]!;
        value += next === "n" ? "\n" : next === "t" ? "\t" : next === '"' ? '"' : "\\";
        j++;
      }
      out.push({ ...start, value, kind: "string" }); continue;
    }
    if ("{};".includes(c)) { out.push({ ...start, value: c, kind: "symbol" }); advance(c); continue; }
    let value = "";
    while (i < input.length && !/\s/.test(input[i]!) && !"{};'\"".includes(input[i]!) && !input.startsWith("//", i) && !input.startsWith("/*", i)) { value += input[i]!; advance(input[i]!); }
    if (!value) throw new YangSyntaxError(`Unexpected character '${c}'`, start);
    out.push({ ...start, value, kind: "word" });
  }
  return { tokens: out, eof: { offset: i, line, column } };
}

/** Parses the YANG statement grammar into a source-located generic AST. */
export function parseYang(source: string): YangModule {
  const { tokens, eof } = tokenize(source); let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];
  function statement(depth = 0): YangStatement {
    if (depth > MAX_STATEMENT_DEPTH) {
      throw new YangSyntaxError("Statement nesting too deep (possible infinite recursion)", tokens[index] ?? eof);
    }
    const key = take();
    if (!key || key.kind !== "word") throw new YangSyntaxError("Expected statement keyword", key ?? eof);
    // Arguments end at the next symbol; a quoted argument may legitimately
    // contain ';', '{' or '}', so symbols are recognized by kind, not value.
    const argumentParts: Token[] = [];
    while (peek() && peek()!.kind !== "symbol") argumentParts.push(take()!);
    // RFC 7950 §6.1.3: quoted strings follow one operand only when joined by
    // '+'; unquoted words separated by whitespace form one argument (key lists).
    let argument = "";
    let hasArgument = false;
    let lastKind: Token["kind"] | undefined;
    let concatenate = false;
    for (const part of argumentParts) {
      if (part.kind === "word" && part.value === "+") { concatenate = true; continue; }
      if (hasArgument && !concatenate && (part.kind === "string" || lastKind === "string")) {
        throw new YangSyntaxError("Expected '+' between adjacent strings", part);
      }
      argument = !hasArgument ? part.value : concatenate ? argument + part.value : `${argument} ${part.value}`;
      hasArgument = true; lastKind = part.kind; concatenate = false;
    }
    const end = take();
    if (!end || end.kind !== "symbol" || (end.value !== ";" && end.value !== "{")) throw new YangSyntaxError("Expected ';' or '{'", end ?? eof);
    const children: YangStatement[] = [];
    if (end.value === "{") {
      while (peek() && peek()!.value !== "}") children.push(statement(depth + 1));
      const close = take();
      if (!close) throw new YangSyntaxError("Unterminated statement block", eof);
    }
    return { keyword: key.value, ...(hasArgument ? { argument } : {}), children, location: { offset: key.offset, line: key.line, column: key.column } };
  }
  const root = statement();
  if (peek()) throw new YangSyntaxError("Unexpected content after module", peek()!);
  if (root.keyword !== "module" && root.keyword !== "submodule") throw new YangSyntaxError("Expected module or submodule", root.location);
  if (!root.argument) throw new YangSyntaxError("Module name is required", root.location);
  return root as YangModule;
}

export function childrenOf(node: YangStatement, keyword: string): YangStatement[] { return node.children.filter(child => child.keyword === keyword); }
export function childOf(node: YangStatement, keyword: string): YangStatement | undefined { return node.children.find(child => child.keyword === keyword); }
