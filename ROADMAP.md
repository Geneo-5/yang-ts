# Roadmap

This roadmap targets an RFC 7950 YANG 1.1 engine that runs entirely in browsers. It is intentionally incremental: a later stage starts only when its predecessor has usable diagnostics and regression fixtures. Stages 0–2 and 3–5 are complete; Stage 6 is in progress with resource budgets and cancellation done. Last updated: 2026-11 (Stage 6 started: module-set budgets and cancellation).

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

## Stage 2 — Semantic compiler and effective schema (complete)

- Validate statement placement/cardinality and YANG 1.1-only rules.
- Compile typedefs, groupings/uses/refine, choices/cases, data nodes, RPCs, actions and notifications to a typed schema IR.
- Resolve identities, prefixes and namespaces.
- Apply augments and deviations; evaluate `if-feature` expressions to create a feature-specific effective schema.
- Preserve source locations and provenance on every compiled node.
- Implemented foundation: data/RPC/notification schema nodes (including top-level declarations in included submodules), effective list-key checks after `uses` expansion and matching `config` inheritance, simple typedef-chain resolution, use-site grouping instantiation and `refine`, QName-based augment paths, explicit and shorthand choice cases, `must`/`when` provenance, feature filtering, and RFC 7950 deviations (`not-supported`, `add`, `replace`, `delete`) with property checks.
- Cardinality diagnostics cover singleton duplicates, required module/type statements and required substatements of the `decimal64`, `leafref`, `enumeration`, `bits`, `union` and `identityref` built-in types, plus type-restriction legality resolved through typedef chains.
- Implemented submodule QName behavior for augments, groupings, typedefs and `if-feature`: imports resolve in the declaring submodule context, while definitions and enabled feature IDs are associated with the `belongs-to` module.
- Implemented nested action compilation from data nodes, grouping instantiations and augments, with schema paths and compiled input/output trees.
- Implemented augments targeting RPC/action `input` and `output` nodes and notification content, including operation path matching across module namespaces; invalid target and child statement kinds produce diagnostics.
- Exit met: the interface base plus the fixture augment modules compile into an inspectable effective tree (`tests/compiler.test.ts`, `tests/yang-fixtures.test.ts`); invalid paths and unresolved names are diagnostics, not silent skips. Residual statement-legality breadth and negative coverage fold into the Stage 6 conformance matrix work.

## Stage 3 — Type system and canonical values (complete)

- Implement all built-in YANG types and restrictions: range, length, pattern, enum, bits, union, decimal64, identityref, leafref and instance-identifier.
- Resolve derived typedef restrictions, defaults and canonical representations.
- Represent int64/uint64/decimal64 exactly for validation; make XPath 1.0's IEEE-754 conversion behavior explicit where applicable.
- Form validation now resolves inherited `min`/`max` range and length bounds from base typedef restrictions for integer, decimal64 and string values; broader value-level restriction validation (additional bounds) remains.
- Form `pattern` restrictions now evaluate as implicitly-anchored regular expressions over the common XML Schema/JavaScript subset; patterns using backreferences, `(?`-prefixed groups or character-class subtraction stay pending with an explicit explanation instead of being misinterpreted.
- Compiler-time restriction legality now rejects `range`, `length`, `pattern`, `path`, `require-instance`, `fraction-digits`, `base`, `enum` and `bit` restrictions applied to a built-in type (resolved through typedef chains) that does not support them.
- Form enum and bits options now honor typedef subset restrictions, and validation rejects values removed by a derived type.
- Form validation tests union members in declaration order and returns indeterminate when no branch can be conclusively validated.
- Form validation checks canonical Base64 syntax and decoded octet length for `binary` without Node APIs.
- Canonical value representations now exist as `canonicalFormOf`: integers drop sign padding and leading zeros within type order, decimal64 re-renders with exactly its inherited `fraction-digits`, boolean normalizes JavaScript booleans, bits re-join selections ordered by bit position (declaration order otherwise), and binary strips insignificant base64 whitespace; cross-reference types stay undefined because they need instance context.
- Leafref and identityref form validation now resolves cross references (`FormCrossReference`, `tests/cross-reference.test.ts`): a leafref value is matched against the declared path evaluated from the anchor element's document, and identityref values are accepted when they name an identity derived from one of the declared bases (module-qualified or plain names, imported prefixes resolved); without context the types stay indeterminate with the explicit pending reason.
- An RFC-linked boundary corpus is checked in (`tests/boundaries.test.ts`): every integer width at its exact boundaries including exact 64-bit bigint values, decimal64 scaled range limits and derived `fraction-digits`, inherited length/range restrictions through typedef chains with derived-range narrowing, implicitly-anchored derived patterns with unsupported XML Schema syntax reported as pending, binary octet-length boundaries over canonical base64, and enum/bits restriction narrowing.
- The corpus exposed a real defect, since fixed: whitespace around the `..` separator in `range` and `length` expressions ("10 .. 90") made endpoints unparsable and the constraint silently satisfied; endpoints are now trimmed and counter-examples at the edges are tested.
- Remaining: residual breadth (unusual restriction combinations, exotic patterns) folds into the Stage 6 conformance matrix.

Exit met: RFC-linked positive/negative type tests, including inherited restrictions and boundary values (`tests/boundaries.test.ts`, `tests/forms.test.ts`, type-restriction compiler tests).

## Stage 4 — XPath 1.0 and YANG evaluation context (complete)

- Compatibility spike selected `xpath@0.0.36` as the XPath 1.0 evaluator candidate and verified YANG current-module QName qualification, list predicates/relative paths over a YANG-shaped tree, and custom functions; see `XPATH_SPIKE.md`.
- XPath 1.0 axes, predicates, coercions and node-set comparisons come from the `xpath` evaluator; the YANG adapter (`compileYangXPath`) adds the YANG-specific rules: unprefixed node tests bind to the current module namespace, and `current()` is bound to the original evaluation context node because the evaluator extends its per-step context inside predicates.
- The RFC 7950 function library is implemented over the compiled schema (`createYangFunctionLibrary`): `current`, `re-match`, `derived-from`, `derived-from-or-self`, `deref`, `enum-value` and `bit-is-set`. `deref` follows leafref paths over built accessible trees (`schemaNodeForElement` maps instance elements back to schema nodes); instance-identifier values still dereference as themselves.
- The accessible tree is modelled (`buildAccessibleTree`): datastore-config prunes `config false` state nodes, datastore-state keeps them, notification and RPC/action input/output are fictional trees holding the operation node with its scope, and declared leaf/leaf-list defaults are injected into datastore contexts for with-defaults evaluation.
- Compiled `must`/`when` constraints evaluate over accessible trees (`createConstraintEvaluator`): `must` uses the data node as context, a node's own `when` evaluates at that node, and whens inherited from an augment/uses/ancestor statement evaluate at the parent element (the introducing node).

Exit met: section-linked tests plus focused cases from the checked-in `if:type` conditions (`encapsulation`, `loopback`, `parent-interface` in `ietf-if-extensions`) and `must` expressions; covered by `tests/xpath.test.ts`, `tests/accessible-tree.test.ts`, `tests/constraints.test.ts`.

## Stage 5 — Validation and conditional UI introspection (complete)

- Validate structural rules, keys, unique, mandatory, min/max-elements, `must`, `when`, leafref and instance-identifier integrity.
- Distinguish invalid, valid and indeterminate results when needed context is absent.
- Expose framework-neutral schema metadata and candidate-value evaluations with explanations.
- For finite domains (enum/bits), evaluate each candidate against a concrete data context; never treat a `must` as a static enumeration filter when it depends on unknown sibling/state data.
- Implemented: `must`/`when` evaluation with valid/invalid/indeterminate statuses over accessible trees (`createConstraintEvaluator`, `tests/constraints.test.ts`); form-level type/required/cardinality validation with the same three statuses (`validateFormValue`); a structural validation pass over whole data trees (`validateDataTree`, `tests/validate-instance.test.ts`) covering list keys, `unique`, `min/max-elements`, `mandatory`, leafref integrity (`require-instance` honored), RFC 7950 instance-identifier parsing and in-document resolution, and re-evaluated `must`/`when` constraints with `when`-probed absence; and contextual finite-domain candidate evaluation (`evaluateCandidates`, `finiteDomainOf`, `tests/candidates.test.ts`): each enum/bits/boolean candidate is substituted into the instance document, its `must`/`when` constraints decide allowed/blocked, unevaluable constraints yield indeterminate instead of a static filter, and every candidate carries per-constraint explanations with the declaring statement as source.

Exit met: end-to-end contextual allowed-value filtering (`tests/candidates.test.ts`) and every result carries a path, source and reason.

## Stage 6 — Browser release readiness (in progress)

- Verify package exports and bundles in current browsers; no Node built-ins, Python, native wrapper or backend.
- Test workers/cancellation/resource budgets for large or untrusted module sets.
- Publish a conformance matrix with implemented/partial/unsupported/untested status and a migration/versioning policy.
- Add optional YANG Library/RESTCONF loading adapters without coupling them into the compiler core.
- Implemented: `resolveModuleSet` accepts `ModuleSetConstraints` (`tests/module-budgets.test.ts`) — an explicit host-owned `AbortSignal` and a `ModuleSetBudget` (max loader-loaded modules and submodules, import/include depth via the loader budget, total loader-reported source characters, wall-clock deadline) that refuse all further loads after the first violation and record a single `cancelled`/`budget-exceeded` diagnostic; unconstrained resolution is unchanged. The deadline is also recorded when the resolution finishes past it.

Exit: browser smoke suite, bundle audit, full fixture corpus, documented known gaps and a repeatable release workflow.

## Principles

- Syntax recognition is not semantic support; unsupported constructs must be explicit.
- Every semantic feature needs an RFC reference and focused regression tests.
- Core accepts module text and configuration; transport and UI frameworks stay at the edges.
- libyang can be a development-time differential oracle, never a runtime requirement in the browser.
