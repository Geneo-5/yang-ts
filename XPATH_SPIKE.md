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

The spike listed what was missing before the adapter could back validation; all of it is closed. Current state, each row backed by its `CONFORMANCE.md` evidence:

- The RFC 7950 accessible tree (§6.4.1) is built by `buildAccessibleTree` for datastore config/state, notification and RPC/action input/output contexts, with declared defaults injected (§7.6.1, case defaults per §7.9.3) and wrapper documents (e.g. NETCONF `<data>`) accepted — `tests/accessible-tree.test.ts`.
- `current()` binds per evaluation to the original context node; the function library (`re-match`, `derived-from(-or-self)`, `deref`, `enum-value`, `bit-is-set`) lives in `src/xpath/yang-functions.ts`. `enum-value` resolves the argument node's own enumeration type through the typedef chain (§10.5.1) and `derived-from*` qualify XML prefixes through each member's in-scope `xmlns` bindings (§9.10.4).
- Prefix maps include the module's own `prefix`, its imports and each declaring document's submodule bindings (`moduleNamespacePrefixes`/`documentNamespacePrefixes`, §6.4.1) — expressions using the module's own prefix resolve.
- `qualifyYangXPathNodeTests` is covered by a seeded differential/fuzz corpus (`tests/differential.test.ts`): the rewrite is a pure prefix insertion and unprefixed and explicitly prefixed spellings agree, mutation-tested.

Still open:

- A single XPath expression cannot be interrupted mid-evaluation: the third-party evaluator is synchronous, so no in-process step/time budget exists. Loading budgets, the schema-node expansion budget, validation/candidate deadlines and worker isolation (`createYangRunner`) cover everything around it.
- Dependency note: `xpath` is the only runtime dependency of the package; it is pre-1.0 and pinned with a caret on a `0.0.x` version (patch range only).
