# Conformance matrix

Statuses: **implemented** (regression-tested, RFC-linked), **partial** (works for a defined slice, gaps named), **planned** (roadmap item, intentionally absent), **untested** (exists without focused coverage). Every change to a row must tick the covering test or the row regresses to `untested`. last-updated 2026-11.

## Parser (RFC 7950 §6)

| Area | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Statement grammar, arguments, quoting, comments | implemented | `tests/parser.test.ts` | Adjacent quoted-string concatenation preserved; source locations on every statement. |
| Real-world fixture corpus | implemented | `tests/yang-fixtures.test.ts` | Sysrepo oven, RFC 8343 interfaces, RFC 8344 IP augments, IETF interface extensions with `when`/`if:type`. |
| Malformed-syntax diagnostics with line/column | implemented | `tests/parser.test.ts` | |

## Module resolution (RFC 7950 §5.1–§5.6)

| Area | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Import/include closure, revision-date, belongs-to | implemented | `tests/module-set.test.ts` | Newest unpinned revision selection; stable ordering. |
| Missing, ambiguous, cyclic dependency diagnostics | implemented | `tests/module-set.test.ts` | Submodule include cycles and invalid belongs-to covered. |
| Resource budgets and cancellation | implemented | `tests/module-budgets.test.ts` | `ModuleSetConstraints`: abort signal, module/submodule counts, source characters, wall-clock deadline. |
| RESTCONF / YANG Library loading adapter | implemented | `tests/restconf-loader.test.ts` | RFC 7895 + RFC 8525 payloads; pure adapter, never in the compiler core. |
| Other transports (filesystem paths, npm packages) | planned | — | Core accepts injected loaders only by design. |

## Compiler and effective schema (RFC 7950 §7)

| Area | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Data/RPC/action/notification schema IR with provenance | implemented | `tests/compiler.test.ts` | Top-level submodule definitions land on the `belongs-to` module. |
| Groupings/uses/refine, choices/cases | implemented | `tests/compiler.test.ts` | Post-expansion list-key and config checks. |
| Augments (data, RPC/action input/output, notification) | implemented | `tests/compiler.test.ts` | QName targets; invalid targets are diagnostics. |
| Deviations (not-supported, add, replace, delete) | implemented | `tests/compiler.test.ts` | Property validity checks. |
| Identity resolution and feature evaluation | implemented | `tests/compiler.test.ts` | `if-feature` filtering creates the effective schema. |
| Full statement-legality breadth (every keyword's grammar) | partial | `tests/compiler.test.ts` | Statement placement/cardinality checked for the modeled subset; residual breadth is tracked as Stage 6 matrix work item by item. |

## Type system (RFC 7950 §9, RFC 6991)

| Area | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Integer, string with range/length/pattern | implemented | `tests/boundaries.test.ts`, `tests/forms.test.ts` | Boundary values per width; patterns implicitly anchored (§9.4.6). |
| Patterns outside the XML Schema/JS common subset | partial | `tests/boundaries.test.ts` | Backrefs, `(?`-groups and class subtraction stay `pending` with the explicit reasons instead of wrong results. |
| decimal64 (exact scaled BigInt arithmetic) | implemented | `tests/boundaries.test.ts`, `tests/canonical.test.ts` | `fraction-digits` inherited through typedef chains. |
| binary base64 (syntax and octet length, no Node APIs) | implemented | `tests/boundaries.test.ts` | |
| enumeration/bits with derived restrictions; bits positions | implemented | `tests/boundaries.test.ts`, `tests/canonical.test.ts` | |
| union validation in declaration order | implemented | `tests/forms.test.ts` | Indeterminate when no branch is conclusive. |
| leafref and identityref cross-references | implemented | `tests/cross-reference.test.ts` | Form-level via `FormCrossReference`; tree-level leafref integrity in `validateDataTree`. |
| instance-identifier (RFC 7950 §9.13) | implemented | `tests/validate-instance.test.ts` | Lexical parse + in-document resolution; `require-instance false` accepts any XPath. |
| Canonical lexical forms (RFC 6991) | partial | `tests/canonical.test.ts` | Integers, decimal64, boolean, bits order, binary whitespace. Unrepresented: identityref/instance-identifier qualification, localized numeric forms. |

## XPath 1.0 and YANG evaluation (RFC 7950 §6.4, §10)

| Area | Status | Evidence | Notes |
| --- | --- | --- | --- |
| XPath 1.0 core (axes, predicates, coercions) | implemented | `tests/xpath.test.ts` | Delegated to the reviewed `xpath` evaluator; browser-safe. |
| Unprefixed names bind to the declaring module namespace | implemented | `tests/xpath.test.ts` | |
| Function library (`current`, `re-match`, `derived-from(-or-self)`, `deref`, `enum-value`, `bit-is-set`) | implemented | `tests/xpath.test.ts`, `tests/constraints.test.ts` | `current()` binds at evaluation because predicates extend the context node. |
| Accessible trees (§6.4.1): datastore config/state, notification, RPC/action I/O | implemented | `tests/accessible-tree.test.ts` | Declared defaults injected in datastore contexts. |
| instance-identifier deref | partial | `tests/constraints.test.ts` | Value not parsed as a path during `deref` (§10.5.2 case); individual nodes fully supported. |

## Validation

| Area | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Structural check: keys, unique, mandatory, min/max-elements | implemented | `tests/validate-instance.test.ts` | |
| must/when re-evaluation with when-probing of absent nodes | implemented | `tests/validate-instance.test.ts`, `tests/constraints.test.ts` | Three-valued valid/invalid/indeterminate. |
| leafref/instance-identifier integrity | implemented | `tests/validate-instance.test.ts` | |
| Contextual candidate evaluation (enum/bits/boolean) | implemented | `tests/candidates.test.ts` | Never a static filter for evaluator-unknown constraints. |
| instance-identifier values referencing other datastores/mount points | planned | — | Schema-mount not supported. |

## Known gaps (explicitly unsupported)

- **Schema-mount (RFC 8528)**: not supported; `instance-identifier`/`deref` across mount points is undefined.
- **Metadata annotations (RFC 7952)**: parser-level statements only; no metadata validation.
- **XML Schema regular-expression edge syntax** (`(?=`, backrefs, class subtraction): pending, never approximated by JavaScript semantics.
- **XPath beyond 1.0 semantics** (e.g. full XML Schema datatypes in comparisons): the evaluator is XPath 1.0; conversions are IEEE-754 per XPath where applicable.
- **No transport**: RESTCONF requests are constructed/validated but never sent by this package.

## Migration and versioning policy

- Semver on the package; the public API is `src/index.ts` exports. Additions are minor; removals or narrowing of exported shapes are major.
- Diagnostics are additive: new `code` values may appear in any minor release. Consumers must treat unknown diagnostic codes as errors-of-record (report, never swallow).
- `capabilities` marks feature levels in-bundle; it reports possession, not conformance — this matrix is the authority.
- The conformance matrix rows change only with a covering test; a regression downgrades the row, never the claims.
