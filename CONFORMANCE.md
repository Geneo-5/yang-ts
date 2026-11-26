# Conformance matrix

Statuses: **implemented** (regression-tested, RFC-linked, no known defect), **partial** (works for a defined slice, gaps named), **planned** (roadmap item, intentionally absent), **untested** (exists without focused coverage). Every change to a row must tick the covering test or the row regresses to `untested`. A row with a known open defect is **partial**, never **implemented**.

Last updated: 2026-11-26, after a full source review and the closure of the Stage 7 P0 batch. Every P0 defect listed at the review landed with a regression in `tests/stage7-p0.test.ts` that failed before its fix; the affected rows below are updated. A row returns to **implemented** only with a covering test — the same rule that downgraded rows during the review applies to upgrades.

## Parser (RFC 7950 §6)

| Area | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Statement grammar, arguments, comments, adjacent-string concatenation, source locations | implemented | `tests/parser.test.ts`, `tests/stage7-p1.test.ts` | RFC 7950 §6.1.3 (2026-11-26): quoted arguments may contain `;`/`{`/`}`; escapes `\n \t \" \\` transformed, any other character after a backslash rejected; multi-line double-quoted strings strip trailing whitespace and continuation-line indentation up to the opening quote's column (tabs count as 8 spaces); empty-string arguments kept; quoted strings concatenate only with `+`; unquoted word lists (e.g. `key a b c`) still join into one argument. |
| Real-world fixture corpus | implemented | `tests/yang-fixtures.test.ts` | Sysrepo oven, RFC 8343 interfaces, RFC 8344 IP augments, IETF interface extensions with `when`/`if:type`. |
| Malformed-syntax diagnostics with line/column | implemented | `tests/parser.test.ts`, `tests/stage7-p1.test.ts` | End-of-input errors report the end of the source (string, unterminated block, missing `;`/`{`, missing keyword); statement nesting capped at depth 200 (2026-11-26). |

## Module resolution (RFC 7950 §5.1–§5.6)

| Area | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Import/include closure, revision-date, belongs-to | implemented | `tests/module-set.test.ts` | Newest unpinned revision selection; stable ordering. Several revisions of one module can coexist in the set and later compile as duplicate roots. |
| Missing, ambiguous, cyclic dependency diagnostics | implemented | `tests/module-set.test.ts` | Submodule include cycles and invalid belongs-to covered. |
| Resource budgets and cancellation | partial | `tests/module-budgets.test.ts`, `tests/stage7-p0.test.ts` | Implemented: abort signal, module/submodule counts, source characters, wall-clock deadline (checked before each load), and `maxDepth` enforced on import/include chains (2026-11-26). Beyond loading (2026-11-26): `compileYangModules(…, { budget: { maxSchemaNodes } })` stops `uses`/grouping expansion with one `budget-exceeded` diagnostic; `validateDataTree` and `evaluateCandidates` accept an `options.signal` and report `indeterminate` with a `cancelled` issue when aborted. Compiled XPath expressions are cached per schema (`WeakMap<CompiledYangSchema, …>`) and the text cache for pattern compilation is bounded (cleared past 2048 entries), so repeated passes on untrusted schemas cannot collide across schemas or grow memory without limit (2026-11-26). Open: a single XPath cannot be interrupted mid-expression in the synchronous third-party evaluator (bound instead by source-character budgets and worker isolation); regex execution is bounded by the pending-pattern guards, not a CPU budget. |
| RESTCONF / YANG Library loading adapter | implemented | `tests/restconf-loader.test.ts` | Pure adapter, never in the compiler core. Library requested under the RFC 8040 `/data/` subtree; RFC 8525 nested `submodule` lists preferred (flat-row fallback for RFC 7895); RFC 7895 `schema` leaf used before the `yang?module=` probe; `AbortSignal` forwarded (2026-11-26). Tests use a simulated fetch. |
| Other transports (filesystem paths, npm packages) | planned | — | Core accepts injected loaders only by design. |

## Compiler and effective schema (RFC 7950 §7)

| Area | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Data/RPC/action/notification schema IR with provenance | implemented | `tests/compiler.test.ts`, `tests/stage7-p1.test.ts` | Top-level submodule definitions land on the `belongs-to` module and compile in the submodule's own document context: its imports and `belongs-to` prefix are visible to its `type`, `uses`, augment paths, deviations and operations, while schema identity stays in the parent module's namespace (2026-11-26). |
| Groupings/uses/refine, choices/cases | partial | `tests/compiler.test.ts`, `tests/stage7-p1.test.ts` | Cross-module grouping descendants carry the instantiating module's namespace (2026-11-26). Refine accepts `mandatory` on leaves (§7.13.2) and `augment` inside `uses` expands into its grouping target (2026-11-26). Typedef/grouping lookup follows §6.2.1 scoping over a per-module-family index (2026-11-26). Open: `when` inherited through several levels evaluates at the immediate parent; name uniqueness across choice cases unchecked. |
| Augments (data, RPC/action input/output, notification) | implemented | `tests/compiler.test.ts`, `tests/stage7-p1.test.ts` | QName targets; invalid targets are diagnostics. Submodule augment children resolve in the submodule's document context (`type`, `uses`, paths); grouped additions share the `unresolved-grouping` rules. |
| Deviations (not-supported, add, replace, delete) | partial | `tests/compiler.test.ts` | Property validity checks on data nodes. Deviations targeting RPC/action/notification nodes are reported as unresolved. |
| Identity resolution and feature evaluation | partial | `tests/compiler.test.ts` | `if-feature` filtering creates the effective schema. Not handled: `if-feature` on `enum`/`bit`, feature-to-feature dependencies. |
| Full statement-legality breadth (every keyword's grammar) | partial | `tests/compiler.test.ts` | Statement placement/cardinality checked for the modeled subset. |

## Type system (RFC 7950 §9, RFC 6991)

| Area | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Integer, string with range/length/pattern | partial | `tests/boundaries.test.ts`, `tests/forms.test.ts`, `tests/stage7-p1.test.ts` | Boundary values per width; patterns implicitly anchored (§9.4.6). `modifier invert-match` honored (2026-11-26). Restrictions ride a serializable `FormField.restrictions` descriptor, so copied, cloned or proxied fields keep validating (2026-11-26). Open: an unparsable `range`/`length` endpoint is treated as unbounded. |
| Patterns outside the XML Schema/JS common subset | implemented | `tests/boundaries.test.ts`, `tests/stage7-p0.test.ts`, `tests/module-budgets.test.ts` | The shared compiler `src/types/xsd-pattern.ts` keeps backrefs, `(?`-groups, class subtraction, `[]` forms, divergent escapes (`\d \D \w \W \s \S \p \P \i \c`) and out-of-class `^`/`$` `pending` — never evaluated with JavaScript semantics (2026-11-26). Untrusted patterns stay pending when oversized (> 256 characters), carry a quantifier bound ≥ 1000, or match the nested-unbounded-quantifier ReDoS shape (2026-11-26). |
| decimal64 (exact scaled BigInt arithmetic) | implemented | `tests/boundaries.test.ts`, `tests/canonical.test.ts` | `fraction-digits` inherited through typedef chains. |
| binary base64 (syntax and octet length, no Node APIs) | implemented | `tests/boundaries.test.ts` | |
| enumeration/bits with derived restrictions; bits positions | implemented | `tests/boundaries.test.ts`, `tests/canonical.test.ts` | `if-feature` on `enum`/`bit` is not honored (see compiler). |
| union validation in declaration order | partial | `tests/forms.test.ts`, `tests/stage7-p1.test.ts` | Indeterminate when no branch is conclusive. Scalar unions and union leaf-lists validate through the field's precomputed member descriptors (each with its own restrictions, 2026-11-26). |
| leafref and identityref cross-references | partial | `tests/cross-reference.test.ts`, `tests/stage7-p1.test.ts` | Form-level via `FormCrossReference`; tree-level leafref integrity in `validateDataTree`. Tree- and form-level leafrefs declared through typedefs are checked (`leafrefPathStatementOf` over the typedef chain, 2026-11-26). Form paths under lists resolve (`findSchemaNodeByPath` strips `[*]`, 2026-11-26) and leaf-lists of leafref/identityref validate entry by entry with `(entry N)` errors (2026-11-26). XML-prefixed identityref values resolve through the value node's in-scope `xmlns` bindings in the function library and through the anchor element in form-level checks (RFC 7950 §9.10.4, 2026-11-26). |
| instance-identifier (RFC 7950 §9.13) | partial | `tests/validate-instance.test.ts` | Lexical parse + in-document resolution by local name (namespaces and prefixes ignored); `require-instance false` accepts any XPath. |
| Canonical lexical forms (RFC 6991) | partial | `tests/canonical.test.ts` | Integers, decimal64, boolean, bits order, binary whitespace. Unrepresented: identityref/instance-identifier qualification, localized numeric forms. |

## XPath 1.0 and YANG evaluation (RFC 7950 §6.4, §10)

| Area | Status | Evidence | Notes |
| --- | --- | --- | --- |
| XPath 1.0 core (axes, predicates, coercions) | implemented | `tests/xpath.test.ts`, `tests/differential.test.ts` | Delegated to the reviewed `xpath` evaluator; browser-safe. Unprefixed-name rewriting is a token heuristic covered by a seeded differential/fuzz corpus since 2026-11-26: the qualified source must differ from the original only by inserted namespace prefixes, and each corpus expression must evaluate identically whether written unprefixed or with explicit module prefixes; the corpus fails under a deliberately broken operator guard (mutation-tested). |
| Unprefixed names bind to the declaring module namespace | implemented | `tests/xpath.test.ts` | |
| Prefix resolution in `must`/`when`/leafref/`derived-from` | implemented | `tests/xpath.test.ts`, `tests/constraints.test.ts`, `tests/stage7-p1.test.ts` | Prefix maps include the module's own `prefix` and its imports, plus each included submodule's imports and `belongs-to` prefix (owner declarations win collisions) (`moduleNamespacePrefixes`, 2026-11-26); the datastore accessible tree supports absolute module-qualified paths. |
| Function library (`current`, `re-match`, `derived-from(-or-self)`, `deref`, `enum-value`, `bit-is-set`) | implemented | `tests/xpath.test.ts`, `tests/constraints.test.ts`, `tests/stage7-p1.test.ts` | `current()` binds at evaluation because predicates extend the context node. `derived-from(-or-self)` iterate the node-set and qualify XML-prefixed values through each member's in-scope `xmlns` bindings (RFC 7950 §9.10.4/§10.4, 2026-11-26); `enum-value` uses the first node-set member's own enumeration type through the typedef chain — empty sets and non-enum nodes return NaN (§10.5.1, 2026-11-26). |
| Accessible trees (§6.4.1): datastore config/state, notification, RPC/action I/O | implemented | `tests/accessible-tree.test.ts`, `tests/stage7-p1.test.ts` | The datastore context node is the datastore document and the data root is its document element, so relative and absolute YANG paths both resolve (2026-11-26); datastore validation consumes the same accessible documents — defaults injected, state hidden in the config context (2026-11-26). Wrapper documents (RFC 7950 §5.3, e.g. NETCONF `<data>`) are accepted 2026-11-26: one accessible root per matching child — including every entry of a top-level list — under a synthetic datastore element standing in for the §6.4.1 virtual root, so relative paths span all roots and cross-root references reach sibling roots; absolute paths still anchor at the document node, i.e. above the wrapper. Case defaults follow §7.9.3 (2026-11-26): a case's defaults apply when the case is present or it is the choice's `default` case with nothing else present — inactive cases never inject. |
| instance-identifier deref | partial | `tests/constraints.test.ts` | Value not parsed as a path during `deref` (§10.5.2 case); individual nodes fully supported. |

## Validation

| Area | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Structural check: keys, unique, mandatory, min/max-elements | partial | `tests/validate-instance.test.ts` | Choice/case members are visited (constraints, cardinality, mandatory-on-active-case) and `unique` implements §7.8.3 step paths with absent-leaf exclusion (both fixed 2026-11-26, `tests/stage7-p0.test.ts`). Open: mandatory descendants of absent non-presence containers are not enforced. |
| must/when re-evaluation with when-probing of absent nodes | implemented | `tests/validate-instance.test.ts`, `tests/stage7-p1.test.ts` | Three-valued valid/invalid/indeterminate. `validateDataTree` validates each root through its accessible datastore document (RFC 7950 §6.4.1): defaults are injected, `includeState: false` hides `config false` subtrees, and the when-probe no longer mutates the caller's document (2026-11-26). |
| leafref/instance-identifier integrity | partial | `tests/validate-instance.test.ts`, `tests/stage7-p0.test.ts` | Typedef-declared leafrefs are resolved through the typedef chain (2026-11-26); form `[*]` paths and leaf-list cross-references are fixed too (2026-11-26, see the type-system row). Remaining gap: XML-prefix identityrefs. |
| Contextual candidate evaluation (enum/bits/boolean) | implemented | `tests/candidates.test.ts`, `tests/stage7-p1.test.ts` | Never a static filter for evaluator-unknown constraints. Targets located through a segmentwise schema chain (choice/case names tolerated, per-segment namespaces so augmented ancestors resolve), list entries selectable by key predicates, ancestors and present siblings with `must`/`when` referencing the node fold into the verdict, and probing runs on a private clone of the instance document (2026-11-26). |
| Form model (`createFormModel`) | partial | `tests/forms.test.ts` | Parallel, parse-tree-based path: ignores `uses`, augments, features, deviations and choice exclusivity (mandatory leaves in any case are `required`). |
| instance-identifier values referencing other datastores/mount points | planned | — | Schema-mount not supported. |

## Known gaps (explicitly unsupported)

- **Schema-mount (RFC 8528)**: not supported; `instance-identifier`/`deref` across mount points is undefined.
- **Metadata annotations (RFC 7952)**: parser-level statements only; no metadata validation.
- **XML Schema regular-expression edge syntax** (`(?=`, backrefs, class subtraction, divergent escapes `\d`/`\w`/`\p{…}`/`\i`/`\c`, out-of-class `^`/`$`): pending, never approximated by JavaScript semantics (enforced by the shared `src/types/xsd-pattern.ts`).
- **Deviations on operations** and **`augment` inside `uses`**: not supported.
- **XPath beyond 1.0 semantics** (e.g. full XML Schema datatypes in comparisons): the evaluator is XPath 1.0; conversions are IEEE-754 per XPath where applicable.
- **No transport**: RESTCONF requests are constructed/validated but never sent by this package.
- **Untrusted-module resource limits**: loading budgets (module/submodule counts, source characters, deadline, import depth) plus a schema-node expansion budget for `uses`/grouping fan-out, pending-pattern guards against oversized or ReDoS-shaped regexes, a parser nesting-depth cap of 200, and cooperative `AbortSignal` cancellation in `resolveModuleSet`, `validateDataTree` and `evaluateCandidates`. Compiled XPath expressions live in a schema-scoped `WeakMap` (a reused module name in a second schema compiles its own paths) and the pattern text cache is bounded (cleared past 2048 entries). A single XPath expression cannot be interrupted mid-evaluation: long-running stores need worker isolation (worker + `terminate`), which is the host's responsibility.
- **Real-browser testing**: all suites run under Node with `@xmldom/xmldom`; no browser run exists yet.

## Migration and versioning policy

- Semver on the package; the public API is `src/index.ts` exports. Because the index uses `export *`, every exported helper is currently part of that surface; curating it into named exports is tracked in `ROADMAP.md` (Stage 7, P3) and will be a documented minor/major change.
- Diagnostics are additive: new `code` values may appear in any minor release. Consumers must treat unknown diagnostic codes as errors-of-record (report, never swallow).
- `capabilities` marks feature levels in-bundle; it reports possession, not conformance — this matrix is the authority. Its values currently lag the implementation (`xpath` and `moduleResolution` still read `"planned"`) and are tracked in `ROADMAP.md`.
- The conformance matrix rows change only with a covering test; a regression downgrades the row, never the claims.
