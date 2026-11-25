# Roadmap

This roadmap targets an RFC 7950 YANG 1.1 engine that runs entirely in browsers. It is intentionally incremental: a later stage starts only when its predecessor has usable diagnostics and regression fixtures. Stages 0 and 1 are complete; Stage 2 is in progress.

## Stage 0 — Parser foundation (complete)

- Parse the YANG statement grammar into a source-located AST.
- Preserve argument values, including adjacent quoted-string concatenation.
- Keep representative fixtures: Sysrepo `oven.yang`; RFC 8343 interfaces; its RFC 8344 IP augment and import closure; IETF interface extension drafts with `when` expressions over `if:type`.
- No claim of semantic compilation, constraint evaluation or RFC conformance yet.

Exit: all checked-in fixtures and negative syntax cases parse or fail with useful source locations; build and tests pass.

## Stage 1 — Module set and dependency resolution (complete)

- Load modules by name and optional revision using an injected asynchronous loader.
- Resolve `import`, `include`, `belongs-to`, revision-date and submodule relationships.
- Detect missing modules, ambiguous revisions and import/include cycles with source-located diagnostics.
- Produce a stable module-set object independent of RESTCONF or the browser's fetch API.
- Current implementation resolves import closures, selects newest unpinned revisions, honors `revision-date`, includes submodules, and reports missing/ambiguous/cyclic dependencies.
- Output ordering is stable by module name and revision; diagnostics retain the dependency statement location.

Exit: complete dependency closures for oven and the interface fixture set; tests cover missing, duplicate and cyclic dependencies. Covered by `tests/module-set.test.ts`.

## Stage 2 — Semantic compiler and effective schema (in progress)

- Validate statement placement/cardinality and YANG 1.1-only rules.
- Compile typedefs, groupings/uses/refine, choices/cases, data nodes, RPCs, actions and notifications to a typed schema IR.
- Resolve identities, prefixes and namespaces.
- Apply augments and deviations; evaluate `if-feature` expressions to create a feature-specific effective schema.
- Preserve source locations and provenance on every compiled node.
- Implemented foundation: data/RPC/notification schema nodes (including top-level declarations in included submodules), effective list-key checks after `uses` expansion and matching `config` inheritance, simple typedef-chain resolution, use-site grouping instantiation and `refine`, QName-based augment paths, explicit and shorthand choice cases, `must`/`when` provenance, feature filtering, and RFC 7950 deviations (`not-supported`, `add`, `replace`, `delete`) with property checks.
- Implemented submodule QName behavior for augments, groupings, typedefs and `if-feature`: imports resolve in the declaring submodule context, while definitions and enabled feature IDs are associated with the `belongs-to` module.
- Remaining: nested actions and operation augments, submodule-aware expression contexts and other edge cases, statement legality/cardinality, complete type restrictions and broader negative coverage.

Exit: the interface base plus all fixture augment modules compile into an inspectable effective tree; invalid paths and unresolved names are diagnostics, not silent skips.

## Stage 3 — Type system and canonical values

- Implement all built-in YANG types and restrictions: range, length, pattern, enum, bits, union, decimal64, identityref, leafref and instance-identifier.
- Resolve derived typedef restrictions, defaults and canonical representations.
- Represent int64/uint64/decimal64 exactly for validation; make XPath 1.0's IEEE-754 conversion behavior explicit where applicable.
- Form validation now resolves inherited `min`/`max` range and length bounds from base typedef restrictions for integer, decimal64 and string values; broader restriction validation and compiler-time restriction legality remain.

Exit: RFC-linked positive/negative type tests, including inherited restrictions and boundary values.

## Stage 4 — XPath 1.0 and YANG evaluation context

- Implement or adopt a parser/evaluator only after a compatibility spike proves QName handling, YANG tree navigation and custom function integration.
- Implement XPath 1.0 axes, predicates, coercions, node-set comparisons, and the YANG-specific root/context/namespace rules.
- Add the RFC 7950 function library: `current`, `re-match`, `derived-from`, `derived-from-or-self`, `deref`, `enum-value` and `bit-is-set`.
- Model the five accessible-tree contexts (datastore config, state, notification, RPC/action input, output) and default nodes.

Exit: section-linked tests plus focused cases from the checked-in `if:type` conditions and `must` expressions.

## Stage 5 — Validation and conditional UI introspection

- Validate structural rules, keys, unique, mandatory, min/max-elements, `must`, `when`, leafref and instance-identifier integrity.
- Distinguish invalid, valid and indeterminate results when needed context is absent.
- Expose framework-neutral schema metadata and candidate-value evaluations with explanations.
- For finite domains (enum/bits), evaluate each candidate against a concrete data context; never treat a `must` as a static enumeration filter when it depends on unknown sibling/state data.

Exit: end-to-end tests for contextual allowed-value filtering and every result carries a path, source and reason.

## Stage 6 — Browser release readiness

- Verify package exports and bundles in current browsers; no Node built-ins, Python, native wrapper or backend.
- Test workers/cancellation/resource budgets for large or untrusted module sets.
- Publish a conformance matrix with implemented/partial/unsupported/untested status and a migration/versioning policy.
- Add optional YANG Library/RESTCONF loading adapters without coupling them into the compiler core.

Exit: browser smoke suite, bundle audit, full fixture corpus, documented known gaps and a repeatable release workflow.

## Principles

- Syntax recognition is not semantic support; unsupported constructs must be explicit.
- Every semantic feature needs an RFC reference and focused regression tests.
- Core accepts module text and configuration; transport and UI frameworks stay at the edges.
- libyang can be a development-time differential oracle, never a runtime requirement in the browser.
