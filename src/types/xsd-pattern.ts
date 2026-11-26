/**
 * RFC 7950 section 9.4.6 / RFC 6991: YANG patterns are implicitly anchored
 * XML Schema regular expressions. JavaScript shares most of the concrete
 * syntax, but silently interprets several constructs differently. A pattern
 * is compiled only when the engine can prove the two interpretations agree;
 * anything else must stay pending rather than be validated with the wrong
 * semantics ("unknown is never valid").
 */

const xsdPatternCache = new Map<string, RegExp | undefined>();

/** Patterns longer than this never reach the regex engine; they stay pending. */
const MAX_PATTERN_LENGTH = 256;

/** Any quantifier bound at 1000 or more keeps the pattern pending. */
const MAX_QUANTIFIER_BOUND = 999;

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
 * Untrusted patterns also stay pending when they are oversized or carry
 * classic exponential-backtracking shapes (a quantifier over a group whose
 * last atom is itself unboundedly quantified), so module-supplied regexes
 * cannot stall the evaluator (ReDoS).
 */
export function compileXsdPattern(pattern: string): RegExp | undefined {
  // Untrusted modules can mint unbounded distinct patterns; the text cache
  // stays bounded by dropping everything once it grows past the ceiling.
  if (xsdPatternCache.size >= 2048) xsdPatternCache.clear();
  if (xsdPatternCache.has(pattern)) return xsdPatternCache.get(pattern);
  let compiled: RegExp | undefined;
  if (pattern.length <= MAX_PATTERN_LENGTH && !oversizedQuantifierBound(pattern) && !hasUnboundedNestedQuantifier(pattern) && !usesDivergentConstruct(pattern)) {
    try { compiled = new RegExp(`^(?:${pattern})$`); } catch { compiled = undefined; }
  }
  xsdPatternCache.set(pattern, compiled);
  return compiled;
}

/** True when a `{n,m}` quantifier bound reaches the pending threshold. */
function oversizedQuantifierBound(pattern: string): boolean {
  const bounds = pattern.matchAll(/\{(\d+)(?:\s*,\s*(\d*))?\}/g);
  for (const match of bounds) {
    if (match[1]!.length > 3) return true;
    if (match[2] !== undefined && match[2].length > 3) return true;
  }
  return false;
}

/**
 * Bounded scan for exponential-backtracking shapes: an unbounded quantifier
 * (`+`, `*`, `{n,}`) applied to a group whose FIRST and LAST atoms are both
 * unboundedly quantified, so successive iterations can split the same run of
 * characters (`(a+)+`, `(a*b*)*`). A literal anchored between iterations (the
 * standard hostname form `[a-z]+(-[a-z]+)*`) keeps iterations deterministic
 * and stays allowed. Heuristic by design — false negatives are acceptable
 * because the pattern check fails closed, and this guard never levels the
 * engine below divergence checking.
 */
function hasUnboundedNestedQuantifier(pattern: string): boolean {
  interface GroupState { sawAtom: boolean; firstAtomCurrent: boolean; firstUnbounded: boolean; lastUnbounded: boolean }
  const stack: GroupState[] = [{ sawAtom: false, firstAtomCurrent: false, firstUnbounded: false, lastUnbounded: false }];
  const startAtom = (): void => {
    const state = stack[stack.length - 1]!;
    state.firstAtomCurrent = !state.sawAtom;
    state.sawAtom = true;
  };
  const finalize = (unbounded: boolean): void => {
    const state = stack[stack.length - 1]!;
    if (state.firstAtomCurrent) state.firstUnbounded = unbounded;
    state.lastUnbounded = unbounded;
  };
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === "\\") { index += 2; continue; }
    if (char === "[") {
      // A class is one atom of its group.
      startAtom();
      index++;
      if (pattern[index] === "^") index++;
      if (pattern[index] === "]") index++;
      while (index < pattern.length && pattern[index] !== "]") {
        if (pattern[index] === "\\") index++;
        index++;
      }
      index++;
      continue;
    }
    if (char === "(") {
      startAtom();
      stack.push({ sawAtom: false, firstAtomCurrent: false, firstUnbounded: false, lastUnbounded: false });
      index++;
      continue;
    }
    if (char === ")") {
      index++;
      const state = stack.pop()!;
      const quantifier = pattern[index];
      let unbounded: boolean;
      if (quantifier === "+" || quantifier === "*") { unbounded = true; index++; }
      else if (quantifier === "{") {
        const closing = pattern.indexOf("}", index);
        unbounded = unboundedBrace(pattern, index, closing);
        index = closing < 0 ? pattern.length : closing + 1;
      } else unbounded = false;
      if (unbounded && state.sawAtom && state.firstUnbounded && state.lastUnbounded) return true;
      // The group is an atom of its parent group; its quantifier applies there.
      finalize(unbounded);
      continue;
    }
    if (char === "+" || char === "*") { finalize(true); index++; continue; }
    if (char === "?") { finalize(false); index++; continue; }
    if (char === "{") {
      const closing = pattern.indexOf("}", index);
      finalize(unboundedBrace(pattern, index, closing));
      index = closing < 0 ? pattern.length : closing + 1;
      continue;
    }
    if (char === "|") {
      // A following atom decides the group's ending again.
      stack[stack.length - 1]!.lastUnbounded = false;
      index++;
      continue;
    }
    startAtom();
    index++;
  }
  return false;
}

/** `{n}` and `{n,m}` ranges are bounded; `{n,}` (or anything malformed) is unbounded. */
function unboundedBrace(pattern: string, open: number, closing: number): boolean {
  if (closing < 0) return true;
  const body = pattern.slice(open + 1, closing);
  return !/^\d+\s*$/.test(body) && !/^\d+\s*,\s*\d+\s*$/.test(body);
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
