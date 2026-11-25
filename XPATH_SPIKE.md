# XPath engine compatibility spike

## Decision

Use the `xpath` package as the XPath 1.0 expression parser/evaluator, with a YANG adapter that supplies module-aware namespace resolution and YANG functions. Do not pass unprefixed YANG node tests directly to a DOM XPath engine: XPath 1.0 treats those as no-namespace names, while RFC 7950 resolves them in the current node's YANG module namespace. The adapter qualifies bare node tests with a synthetic prefix mapped to the current module namespace.

## Candidate review

- `xpath@0.0.36` is an MIT, pure JavaScript DOM XPath 1.0 implementation. Its package includes TypeScript declarations, an expression parser/evaluator API, namespace resolvers and custom function resolvers. The runtime package has no dependencies and the project package audit found no Node built-in imports or `process`/`Buffer` use in its evaluator source.
- FontoXPath is pure JavaScript and browser compatible, but implements XPath 3.1 with XPath 1.0 compatibility mode off. It cannot be used as the YANG evaluator without extra compatibility work.
- Google's Wicked Good XPath implements XPath 1.0 but its upstream repository is archived, so it is not the preferred dependency.

## Spike evidence

`src/xpath/xpath.ts` compiles expressions and maps unprefixed element node tests to the module namespace while leaving function calls, literals, operators, attributes and axis names intact. Tests verify current-module names, imported namespace prefixes, same-local-name isolation across modules, list predicates and relative paths over a YANG-shaped interface tree, and a custom function call. The runtime module only accepts a DOM `Node`, so it can use the browser's XML DOM; `@xmldom/xmldom` is a development-only test dependency.

## Limits before adopting for validation

- This spike does not construct the RFC 7950 accessible tree from YANG JSON/data, including defaults, state/config visibility, RPC/action scopes or notification scope.
- `current()` needs YANG's original-expression-context semantics; custom function support alone does not prove this behavior.
- YANG functions (`re-match`, `derived-from*`, `deref`, `enum-value`, `bit-is-set`) are not implemented here.
- XML DOM node ordering and identityref string values need explicit mapping from the effective schema and data.
- XPath expression rewriting is covered by focused examples, not the full XPath 1.0 grammar corpus or differential testing yet.

The dependency choice is therefore a viable evaluator candidate, not a claim that the Stage 4 YANG XPath implementation is complete.
