# Conformance matrix

Statuses: **implemented** (regression-tested, RFC-linked, no known defect), **partial** (works for a defined slice, gaps named), **planned** (roadmap item, intentionally absent), **untested** (exists without focused coverage). Every change to a row must tick the covering test or the row regresses to `untested`. A row with a known open defect is **partial**, never **implemented**.

Last updated: 2026-11-26, after a full source review. Rows that were previously **implemented** were downgraded to **partial** where the review found open defects. The defects come from reading the code and are tracked in `ROADMAP.md` (Stages 0–7); each still needs a failing regression test to be confirmed, and the row returns to **implemented** only when that test and its fix land.

## Parser (RFC 7950 §6)

| Area | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Statement grammar, arguments, comments, adjacent-string concatenation, source locations | partial | `tests/parser.test.ts` | Open: quoted `";"`/`"{"` end the argument (token `kind` not checked); double-quoted escapes drop the backslash (`\n` → `n`); multi-line string indentation/trailing whitespace not stripped (§6.1.3); empty-string arguments are dropped; several arguments without `+` are joined instead of rejected. |
| Real-world fixture corpus | implemented | `tests/yang-fixtures.test.ts` | Sysrepo oven, RFC 8343 interfaces, RFC 8344 IP augments, IETF interface extensions with `when`/`if:type`. |
| Malformed-syntax diagnostics with line/column | partial | `tests/parser.test.ts` | End-of-input errors report the keyword (or line 1) instead of the end of input; no nesting-depth limit. |

## Module resolution (RFC 7950 §5.1–§5.6)

| Area | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Import/include closure, revision-date, belongs-to | implemented | `tests/module-set.test.ts` | Newest unpinned revision selection; stable ordering. Several revisions of one module can coexist in the set and later compile as duplicate roots. |
| Missing, ambiguous, cyclic dependency diagnostics | implemented | `tests/module-set.test.ts` | Submodule include cycles and invalid belongs-to covered. |
| Resource budgets and cancellation | partial | `tests/module-budgets.test.ts` | Implemented: abort signal, module/submodule counts, source characters, wall-clock deadline (checked before each load). Open: `maxDepth` is declared but never enforced; synchronous parsing cannot be interrupted; no budget for compilation, XPath or regex execution. |
| RESTCONF / YANG Library loading adapter | partial | `tests/restconf-loader.test.ts` | Pure adapter, never in the compiler core. Open: default library URL omits `/data/` (RFC 8040); submodules are looked up as module rows instead of the nested `submodule` lists (RFC 7895/8525); RFC 7895 `schema` ignored (only `location`); no `AbortSignal` option. Tests use a simulated fetch. |
| Other transports (filesystem paths, npm packages) | planned | — | Core accepts injected loaders only by design. |

## Compiler and effective schema (RFC 7950 §7)

| Area | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Data/RPC/action/notification schema IR with provenance | partial | `tests/compiler.test.ts` | Top-level submodule definitions land on the `belongs-to` module, but they are compiled in the parent module's context: imports/prefixes declared only in the submodule are not visible to their `type`, `uses` and XPath. |
| Groupings/uses/refine, choices/cases | partial | `tests/compiler.test.ts` | Open: nested nodes of a grouping defined in another module get the grouping's module/namespace (false `invalid-key` on lists in shared groupings); `refine` of a leaf rejects `mandatory`; `augment` inside `uses` ignored; typedef/grouping lookup ignores scoping rules and is O(N²); `when` inherited through several levels evaluates at the immediate parent; name uniqueness across choice cases unchecked. |
| Augments (data, RPC/action input/output, notification) | partial | `tests/compiler.test.ts` | QName targets; invalid targets are diagnostics. Augment children of submodules share the submodule-context gap above. |
| Deviations (not-supported, add, replace, delete) | partial | `tests/compiler.test.ts` | Property validity checks on data nodes. Deviations targeting RPC/action/notification nodes are reported as unresolved. |
| Identity resolution and feature evaluation | partial | `tests/compiler.test.ts` | `if-feature` filtering creates the effective schema. Not handled: `if-feature` on `enum`/`bit`, feature-to-feature dependencies. |
| Full statement-legality breadth (every keyword's grammar) | partial | `tests/compiler.test.ts` | Statement placement/cardinality checked for the modeled subset. |

## Type system (RFC 7950 §9, RFC 6991)

| Area | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Integer, string with range/length/pattern | partial | `tests/boundaries.test.ts`, `tests/forms.test.ts` | Boundary values per width; patterns implicitly anchored (§9.4.6). Open: `modifier invert-match` is ignored; an unparsable `range`/`length` endpoint is treated as unbounded; validation relies on a `WeakMap` keyed by field identity, so copied, cloned or proxied `FormField` objects silently lose restrictions. |
| Patterns outside the XML Schema/JS common subset | partial | `tests/boundaries.test.ts` | Backrefs, `(?`-groups and class subtraction stay `pending`. Open: `\p{…}` (no `u` flag), `^`/`$` (literals in XSD, anchors in JS), Unicode-wide `\d`/`\w`, `\i`/`\c` are still evaluated with JavaScript semantics and must become `pending`. |
| decimal64 (exact scaled BigInt arithmetic) | implemented | `tests/boundaries.test.ts`, `tests/canonical.test.ts` | `fraction-digits` inherited through typedef chains. |
| binary base64 (syntax and octet length, no Node APIs) | implemented | `tests/boundaries.test.ts` | |
| enumeration/bits with derived restrictions; bits positions | implemented | `tests/boundaries.test.ts`, `tests/canonical.test.ts` | `if-feature` on `enum`/`bit` is not honored (see compiler). |
| union validation in declaration order | partial | `tests/forms.test.ts` | Indeterminate when no branch is conclusive. Union leaf-lists are always indeterminate (resolved member types are not copied for items). |
| leafref and identityref cross-references | partial | `tests/cross-reference.test.ts` | Form-level via `FormCrossReference`; tree-level leafref integrity in `validateDataTree`. Open: leafrefs declared through a typedef are never checked at tree level; form paths carry `[*]` for lists so cross-reference checks under lists stay `pending`; leaf-lists of leafref/identityref with a context always report an error; identityref values are resolved as `module-name:identity`, not through XML namespace prefixes. |
| instance-identifier (RFC 7950 §9.13) | partial | `tests/validate-instance.test.ts` | Lexical parse + in-document resolution by local name (namespaces and prefixes ignored); `require-instance false` accepts any XPath. |
| Canonical lexical forms (RFC 6991) | partial | `tests/canonical.test.ts` | Integers, decimal64, boolean, bits order, binary whitespace. Unrepresented: identityref/instance-identifier qualification, localized numeric forms. |

## XPath 1.0 and YANG evaluation (RFC 7950 §6.4, §10)

| Area | Status | Evidence | Notes |
| --- | --- | --- | --- |
| XPath 1.0 core (axes, predicates, coercions) | implemented | `tests/xpath.test.ts` | Delegated to the reviewed `xpath` evaluator; browser-safe. Unprefixed-name rewriting is a token heuristic without a fuzz/differential corpus yet. |
| Unprefixed names bind to the declaring module namespace | implemented | `tests/xpath.test.ts` | |
| Prefix resolution in `must`/`when`/leafref/`derived-from` | partial | `tests/xpath.test.ts`, `tests/constraints.test.ts` | Prefix maps are built from `import` statements only; the module's own `prefix` is missing, so expressions using it are `indeterminate` and the leafref resolver can throw. |
| Function library (`current`, `re-match`, `derived-from(-or-self)`, `deref`, `enum-value`, `bit-is-set`) | partial | `tests/xpath.test.ts`, `tests/constraints.test.ts` | `current()` binds at evaluation because predicates extend the context node. `enum-value` uses a schema-wide name table and fails on ambiguous names instead of using the argument node's type. |
| Accessible trees (§6.4.1): datastore config/state, notification, RPC/action I/O | partial | `tests/accessible-tree.test.ts` | Declared defaults injected in datastore contexts. Open: only a single root element is accepted (no wrapper document); defaults of inactive cases are injected. |
| instance-identifier deref | partial | `tests/constraints.test.ts` | Value not parsed as a path during `deref` (§10.5.2 case); individual nodes fully supported. |

## Validation

| Area | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Structural check: keys, unique, mandatory, min/max-elements | partial | `tests/validate-instance.test.ts` | Open: nodes under `choice`/`case` are not visited at all; `unique` compares descendant paths by local name (false `unique-violation` for multi-step or prefixed paths; entries missing a leaf must be excluded per §7.8.3); mandatory descendants of absent non-presence containers are not enforced. |
| must/when re-evaluation with when-probing of absent nodes | partial | `tests/validate-instance.test.ts`, `tests/constraints.test.ts` | Three-valued valid/invalid/indeterminate. Open: evaluates the raw document, not the accessible tree (defaults not injected, state not hidden in config contexts). |
| leafref/instance-identifier integrity | partial | `tests/validate-instance.test.ts` | See the type-system rows: typedef-declared leafrefs are silently skipped. |
| Contextual candidate evaluation (enum/bits/boolean) | partial | `tests/candidates.test.ts` | Never a static filter for evaluator-unknown constraints. Open: element lookup uses `node.path` (including choice/case segments) and the leaf's namespace for every ancestor, so augmented nodes and nodes under choices are not found; no way to target a specific list entry; the caller's document is mutated without `try/finally`; only constraints declared on the node itself are considered. |
| Form model (`createFormModel`) | partial | `tests/forms.test.ts` | Parallel, parse-tree-based path: ignores `uses`, augments, features, deviations and choice exclusivity (mandatory leaves in any case are `required`). |
| instance-identifier values referencing other datastores/mount points | planned | — | Schema-mount not supported. |

## Known gaps (explicitly unsupported)

- **Schema-mount (RFC 8528)**: not supported; `instance-identifier`/`deref` across mount points is undefined.
- **Metadata annotations (RFC 7952)**: parser-level statements only; no metadata validation.
- **XML Schema regular-expression edge syntax** (`(?=`, backrefs, class subtraction): pending, never approximated by JavaScript semantics. Further divergences (`\p{…}`, `^`/`$`, Unicode `\d`/`\w`, `\i`/`\c`) are open defects, not yet pending.
- **Deviations on operations** and **`augment` inside `uses`**: not supported.
- **XPath beyond 1.0 semantics** (e.g. full XML Schema datatypes in comparisons): the evaluator is XPath 1.0; conversions are IEEE-754 per XPath where applicable.
- **No transport**: RESTCONF requests are constructed/validated but never sent by this package.
- **Untrusted-module resource limits**: budgets cover loading only. Grouping expansion, XPath evaluation, regex execution and parser nesting depth are unbounded.
- **Real-browser testing**: all suites run under Node with `@xmldom/xmldom`; no browser run exists yet.

## Migration and versioning policy

- Semver on the package; the public API is `src/index.ts` exports. Because the index uses `export *`, every exported helper is currently part of that surface; curating it into named exports is tracked in `ROADMAP.md` (Stage 7, P3) and will be a documented minor/major change.
- Diagnostics are additive: new `code` values may appear in any minor release. Consumers must treat unknown diagnostic codes as errors-of-record (report, never swallow).
- `capabilities` marks feature levels in-bundle; it reports possession, not conformance — this matrix is the authority. Its values currently lag the implementation (`xpath` and `moduleResolution` still read `"planned"`) and are tracked in `ROADMAP.md`.
- The conformance matrix rows change only with a covering test; a regression downgrades the row, never the claims.
