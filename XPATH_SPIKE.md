# XPath engine compatibility spike

## Decision

Use the `xpath` package as the XPath 1.0 expression parser/evaluator, with a YANG adapter that supplies module-aware namespace resolution and YANG functions. Do not pass unprefixed YANG node tests directly to a DOM XPath engine: XPath 1.0 treats those as no-namespace names, while RFC 7950 resolves them in the current node's YANG module namespace. The adapter qualifies bare node tests with a synthetic prefix mapped to the current module namespace.

## Candidate review

- `xpath@0.0.36` is an MIT, pure JavaScript DOM XPath 1.0 implementation. Its package includes TypeScript declarations, an expression parser/evaluator API, namespace resolvers and custom function resolvers. The runtime package has no dependencies and the project package audit found no Node built-in imports or `process`/`Buffer` use in its evaluator source.
- FontoXPath is pure JavaScript and browser compatible, but implements XPath 3.1 with XPath 1.0 compatibility mode off. It cannot be used as the YANG evaluator without extra compatibility work.
- Google's Wicked Good XPath implements XPath 1.0 but its upstream repository is archived, so it is not the preferred dependency.

## Spike evidence

`src/xpath/xpath.ts` compiles expressions and maps unprefixed element node tests to the module namespace while leaving function calls, literals, operators, attributes and axis names intact. Tests verify current-module names, imported namespace prefixes, same-local-name isolation across modules, list predicates and relative paths over a YANG-shaped interface tree, and a custom function call. The runtime module only accepts a DOM `Node`, so it can use the browser's XML DOM; `@xmldom/xmldom` is a development-only test dependency.

## Status of the original limits (2026-11-26)

The spike listed what was missing before the adapter could back validation. Most of it has since been built; what remains is recorded here and in `ROADMAP.md` (Stage 4 and Stage 7).

Resolved:

- The RFC 7950 accessible tree (§6.4.1) is built by `buildAccessibleTree` for datastore config/state, notification and RPC/action input/output contexts, with declared defaults injected in datastore contexts.
- `current()` is bound per evaluation to the original context node.
- The function library (`re-match`, `derived-from`, `derived-from-or-self`, `deref`, `enum-value`, `bit-is-set`) exists in `src/xpath/yang-functions.ts`.

Still open:

- The prefix→namespace maps contain imported prefixes only; the module's own `prefix` is missing, so expressions using it fail to resolve.
- Identityref values are matched as `module-name:identity`; XML prefixes bound by namespace are not mapped back to modules.
- `enum-value` uses a schema-wide name table rather than the argument node's type.
- `buildAccessibleTree` accepts a single root element and injects defaults of inactive cases.
- `qualifyYangXPathNodeTests` is a token-scanning heuristic covered by focused examples, not by the full XPath 1.0 grammar or a differential/fuzz corpus.
- No step or time budget exists for evaluating XPath from untrusted modules.
- Dependency note: `xpath` is the only runtime dependency of the package; it is pre-1.0 and pinned with a caret on a `0.0.x` version (patch range only).
