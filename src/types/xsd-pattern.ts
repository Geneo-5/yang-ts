/**
 * RFC 7950 section 9.4.6 / RFC 6991: YANG patterns are implicitly anchored
 * XML Schema regular expressions. JavaScript shares most of the concrete
 * syntax, but silently interprets several constructs differently. A pattern
 * is compiled only when the engine can prove the two interpretations agree;
 * anything else must stay pending rather than be validated with the wrong
 * semantics ("unknown is never valid").
 */

const xsdPatternCache = new Map<string, RegExp | undefined>();

/**
 * Compile an XML Schema pattern to an anchored JavaScript regex over the
 * proven-safe subset, or return `undefined` when the pattern stays pending.
 * The syntax elements that diverge (and are therefore rejected here):
 * - `\\d \\D \\w \\W \\s \\S \\p \\P \\i \\c` — XSD character classes are
 *   Unicode-wide (`\\d` = Nd, `\\s` = XML whitespace), while JavaScript
 *   compiles them ASCII-wide or as literal letters;
 * - `^` and `$` outside a character class — anchors in JavaScript, ordinary
 *   characters in XML Schema;
 * - backreferences `\\1…\\9` and `(?`-prefixed groups — accepted or rejected
 *   differently, or regex-injection risk in JavaScript;
 * - character-class subtraction `[a-[b]]` and `[]`/`[^]` forms, which XML
 *   Schema treats differently from JavaScript.
 */
export function compileXsdPattern(pattern: string): RegExp | undefined {
  const cached = xsdPatternCache.get(pattern);
  if (cached !== undefined) return cached;
  if (xsdPatternCache.has(pattern)) return undefined;
  let compiled: RegExp | undefined;
  if (!usesDivergentConstruct(pattern)) {
    try { compiled = new RegExp(`^(?:${pattern})$`); } catch { compiled = undefined; }
  }
  xsdPatternCache.set(pattern, compiled);
  return compiled;
}

/** Map of escape letters where XML Schema and JavaScript regexes disagree. */
const DIVERGENT_ESCAPES = new Set("dDwWsSpPiIcC".split(""));

function usesDivergentConstruct(pattern: string): boolean {
  let inside = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === "\\") {
      const next = pattern[index + 1] ?? "";
      index++;
      if (next === "") return true; // trailing backslash: never anchored-sanely
      if (!inside && /[1-9]/.test(next)) return true; // backreference
      if (DIVERGENT_ESCAPES.has(next)) return true;
      continue;
    }
    if (!inside) {
      if (character === "^" || character === "$") return true;
      if (character === "(" && pattern[index + 1] === "?") return true;
      if (character === "[") inside = true;
      continue;
    }
    if (character === "[" && pattern[index + 1] === "]") return true; // "[...[]" form
    if (character === "-" && pattern[index + 1] === "[") return true; // subtraction
    if (character === "]") inside = false;
  }
  return false;
}
