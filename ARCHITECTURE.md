# Architecture and conformance plan

## Audit decision (2026-11-25)

This is a new browser-first TypeScript package, not a wrapper around libyang or a port that assumes a server runtime. `yang-js` remains a useful comparison/reference, but its published package is 0.24.70, last published about two years ago, and its npm metadata still points to RFC 6020; it is not an adequate single source of RFC 7950 behavior. xYang is an independent practical subset and has useful implementation ideas, but does not claim full RFC conformance. Neither is adopted as a runtime dependency.

RFC 7950 uses XPath 1.0 semantics, with YANG-specific namespace resolution, an accessible data tree, context rules, and additional functions. Generic browser `document.evaluate()` is unsuitable because YANG instance data is not necessarily a DOM and YANG's unprefixed-name rules differ. `@designliquido/xpath` is a possible parser/evaluator to prototype against, but must pass a compatibility spike for custom YANG node navigation, QName resolution and functions before adoption. The initial runtime has zero dependencies so the browser bundle cannot accidentally pull in Node APIs.

## Package boundaries

- `yang/`: source tokenizer, statement AST, parser, module dependency resolver and initial semantic compiler/IR.
- `xpath/` (planned): XPath 1.0 expression AST/evaluator, YANG function library and RFC-defined context adapters.
- `types/` (planned): builtin and derived types, canonicalization, restrictions, unions, identity graph and leafref paths.
- `features/` (planned): feature expression evaluation, deviations and effective schema views.
- `constraints/` (planned): `must`, `when`, choice/case, mandatory/cardinality, keys, unique and referential integrity.
- `ui/` (planned): framework-neutral schema introspection and candidate-value explanation; no UI framework dependency.
- RESTCONF/YANG Library adapters stay an optional package layer and are not part of the core compiler.

## RFC 7950 scope, staged

The intended target is YANG 1.1 (RFC 7950), not a claim of compliance today. The planned compiler covers module/submodule grammar, imports/revisions/includes, typedef/grouping/use/augment/refine, data/RPC/action/notification nodes, identities, features, deviations and all builtin types. The semantic layer must implement XPath 1.0 plus YANG functions, `must`/`when`, leafref and instance-identifier constraints, canonical values/defaults, and effective schemas after features/deviations.

The parser milestone covers parsing source into a location-bearing generic statement AST. A small form helper now derives field metadata and validates selected local type restrictions, but it does not compile schema nodes, resolve augments/features/deviations, evaluate XPath or fully validate data. Each semantic milestone needs RFC-directed fixtures, explicit unsupported-feature diagnostics and interoperability comparisons; “recognized syntax” must never be reported as “implemented semantics.”

The current Stage 1 resolver accepts parsed roots plus an injected async loader, resolves import/include closures and revision selection, and returns source-located diagnostics. Stage 2 now creates a source-linked schema tree, instantiates groupings in the use-site namespace, applies `refine`, resolves builtin/simple derived types (including typedefs from included submodules), materializes implicit choice cases, applies QName-based augments with declaring-submodule imports and `belongs-to` prefix, diagnoses invalid augment targets/children, compiles `if-feature` declarations from submodules, applies all four RFC 7950 deviation operations, builds identity inheritance with cycle checks, and compiles top-level operations plus nested actions from data nodes, groupings and augments. RPC/action input/output trees and notification data can receive augments. The compiler is still partial: complete submodule contexts for XPath/features and full statement legality/cardinality remain unimplemented; no full RFC conformance is claimed.

Candidate values are contextual. A finite enumeration can be filtered when constraints can be evaluated over a complete, concrete data context; arbitrary `must` expressions can depend on sibling/ancestor/other-module values, missing nodes, defaults or state data. The API must therefore report `allowed`, `rejected`, or `indeterminate` with reasons, rather than promise that every possible value set can always be statically enumerated.

## Browser and dependency policy

- Runtime: TypeScript/ES2022 ESM, no Node built-ins, filesystem, subprocess, Python or native/WASM wrapper.
- Parsing YANG is implemented in package source to preserve source locations and control grammar behavior.
- Test/build tooling is dev-only: TypeScript and Vitest. No runtime dependency is selected until a documented compatibility and bundle audit passes.
- Keep core independent of fetch, RESTCONF, framework, and persistence. Provide async module-loader interfaces later so callers can decide how YANG Library resources are obtained.
- Use resource limits and cancellation for untrusted or large server-provided modules before exposing compilation in a UI.

## Planned package layout

```text
src/
  yang/       tokenizer, parser, module resolver, compiler, schema IR
  xpath/      parser, evaluator, YANG functions, context adapters
  types/      builtin types, derived types, identity and leafref resolution
  features/   feature expressions and deviations
  validation/ data tree, must/when/type/structural validation
  ui/         framework-neutral schema and candidate-value APIs
tests/
  parser/ xpath/ compiler/ validation/ fixtures/
```

## Quality gates

1. Parser fixtures and negative grammar cases.
2. RFC section-linked unit cases for type restrictions, XPath contexts/functions and constraint timing.
3. Differential checks against libyang in development/CI only, if available; libyang is not shipped or run in users' browsers.
4. Browser bundle inspection and browser tests before declaring the package browser-ready.
5. Conformance matrix labels each feature as implemented, partial, unsupported or untested.
