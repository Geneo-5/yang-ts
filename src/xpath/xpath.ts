import { parse, XPathFunction, XPathResult } from "xpath";

export interface YangXPathEvaluationOptions {
  node: Node;
  functions?: Record<string, XPathFunction> | ((name: string, namespace: string | null) => XPathFunction | null | undefined);
}

export interface CompiledYangXPath {
  readonly source: string;
  readonly qualifiedSource: string;
  evaluate(options: YangXPathEvaluationOptions): XPathResult;
  evaluateBoolean(options: YangXPathEvaluationOptions): boolean;
  evaluateNumber(options: YangXPathEvaluationOptions): number;
  evaluateString(options: YangXPathEvaluationOptions): string;
  select(options: YangXPathEvaluationOptions): Node[];
}

function isNameStart(character: string | undefined): boolean {
  return Boolean(character && /[A-Za-z_]/.test(character));
}
function isNamePart(character: string | undefined): boolean {
  return Boolean(character && /[A-Za-z0-9_.-]/.test(character));
}

/** Add an explicit module namespace to unprefixed XPath node tests (YANG 1.1, section 6.4.1). */
export function qualifyYangXPathNodeTests(expression: string, namespacePrefix: string): string {
  const replacements: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < expression.length) {
    const character = expression[index]!;
    if (character === "'" || character === '"') {
      const quote = character;
      index++;
      while (index < expression.length && expression[index] !== quote) index++;
      index++;
      continue;
    }
    if (!isNameStart(character)) { index++; continue; }
    const start = index++;
    while (isNamePart(expression[index])) index++;
    const end = index;
    let previous = start - 1;
    while (previous >= 0 && /\s/.test(expression[previous]!)) previous--;
    let next = end;
    while (next < expression.length && /\s/.test(expression[next]!)) next++;
    const token = expression.slice(start, end);
    const previousCharacter = expression[previous];
    const nextCharacter = expression[next];
    const isAxisStep = previousCharacter === ":" && expression.slice(0, previous + 1).endsWith("::");
    const isPrefixedName = nextCharacter === ":" || (previousCharacter === ":" && !isAxisStep);
    const isFunctionOrAxis = nextCharacter === "(" || expression.slice(next, next + 2) === "::";
    const isVariableOrAttribute = previousCharacter === "$" || previousCharacter === "@";
    const isOperator = ["and", "or", "div", "mod"].includes(token)
      && previous >= 0
      && /[A-Za-z0-9_.\])'\"]/.test(previousCharacter!);
    if (!isPrefixedName && !isFunctionOrAxis && !isVariableOrAttribute && !isOperator) replacements.push({ start, end });
  }
  return replacements.reduceRight((qualified, replacement) =>
    `${qualified.slice(0, replacement.start)}${namespacePrefix}:${qualified.slice(replacement.start)}`,
  expression);
}

function unusedPrefix(expression: string): string {
  let suffix = 0;
  let prefix = "__yang_ns";
  while (new RegExp(`(?:^|[^A-Za-z0-9_.-])${prefix}\\s*:`).test(expression)) prefix = `__yang_ns${++suffix}`;
  return prefix;
}

/** Compile RFC 7950 XPath 1.0 expressions while mapping unprefixed node tests to their YANG namespace. */
export function compileYangXPath(
  expression: string,
  moduleNamespace: string,
  importedNamespaces: Readonly<Record<string, string>> = {},
): CompiledYangXPath {
  const prefix = unusedPrefix(expression);
  const qualifiedSource = qualifyYangXPathNodeTests(expression, prefix);
  const parsed = parse(qualifiedSource);
  const namespaces = { ...importedNamespaces, [prefix]: moduleNamespace };
  const evaluationOptions = (options: YangXPathEvaluationOptions) => ({
    node: options.node,
    namespaces,
    functions: {
      // RFC 7950 section 10.1: current() returns the original context node even
      // inside predicates, where the evaluator's own contextNode has advanced.
      current: () => options.node,
      ...(options.functions ?? {}),
    },
    allowAnyNamespaceForNoPrefix: false,
  });
  const evaluate = (options: YangXPathEvaluationOptions) => parsed.evaluate(evaluationOptions(options));
  return {
    source: expression,
    qualifiedSource,
    evaluate,
    evaluateBoolean: options => evaluate(options).booleanValue(),
    evaluateNumber: options => evaluate(options).numberValue(),
    evaluateString: options => evaluate(options).stringValue(),
    select: options => parsed.select(evaluationOptions(options)),
  };
}
