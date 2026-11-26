# Roadmap

This roadmap targets an RFC 7950 YANG 1.1 engine that runs entirely in browsers. It is intentionally incremental: a later stage starts only when its predecessor has usable diagnostics and regression fixtures.

**Status as of 2026-11-26 (after a full source review).** Stages 0–6 delivered their intended feature slices, but the review found defects that make several of them *partial* rather than *complete*. Earlier revisions of this file declared every stage complete; that overstated the state. Status labels now follow `CONFORMANCE.md`:

- **done** — regression-tested, no known defect.
- **done, defects open** — the feature slice exists and is tested, but known bugs are listed under the stage and tracked in Stage 7.
- **partial** — a defined slice works; named gaps remain.

A stage returns to **done** only when every defect listed under it is closed by a test that failed before the fix. Items marked `[x]` are closed with a red-then-green regression (`tests/stage7-p0.test.ts`, `tests/stage7-p1.test.ts`, 2026-11-26); `[ ]` items still need a failing test first.

**Re-review after the fixes (2026-11-26).** The Stage 7 P0/P1 fixes were re-read in full. Method: every file of `src/` was read; a copy of `src/` was type-checked with `tsc --strict` (clean) and exercised with throw-away Vitest probes; the project's own suite and fixture corpus were not run in that environment, so the closures below are taken from the tests' content, not from a green run. The re-review confirmed most closures, qualified a few overstated ones and found new defects, one of them a regression introduced by the scoping fix (typedefs and groupings declared inside data nodes are no longer found). They are collected in **Stage 7b**; the `[x]` lines they qualify carry a pointer to it. A stage that has a Stage 7b item cannot return to **done**.

## Stage 0 — Parser foundation (done)

- Parse the YANG statement grammar into a source-located AST; preserve adjacent quoted-string concatenation.
- Fixtures: Sysrepo `oven.yang`; RFC 8343 interfaces, RFC 8344 IP augment and import closure; IETF interface extension drafts with `when` over `if:type`.

Defects found by the review, all closed 2026-11-26 by the Stage 7 P1 parser item (regressions in `tests/stage7-p1.test.ts`); one leniency remains (Stage 7b P2):
- [x] Quoted strings are compared by token kind, so a literal `";"` or `"{"` no longer terminates the statement.
- [x] Double-quoted escapes `\n \t \" \\` transform per RFC 7950 section 6.1.3 and unknown escapes are rejected.
- [x] Multi-line double-quoted strings strip trailing whitespace and indentation up to the opening quote's column.
- [x] Empty-string arguments stay distinguishable; adjacent quoted strings without `+` are rejected.
- [x] EOF errors report the end of the source; parser nesting is capped at depth 200.

## Stage 1 — Module set and dependency resolution (done, defects open)

- Injected async loader, import/include/belongs-to closure, revision selection, missing/ambiguous/cyclic diagnostics, stable ordering.
- `ModuleSetConstraints`: abort signal, module/submodule counts, source characters, wall-clock deadline.

Open defects:
- [x] `ModuleSetBudget.maxDepth` is enforced on import and include chains since 2026-11-26 (single `budget-exceeded` diagnostic, refusing mode), regression-tested in `tests/stage7-p0.test.ts`.
- [ ] Revisions (partly closed 2026-11-26): `resolveModuleSet` selects the newest unpinned revision per load and reports `ambiguous-revision` for duplicate sources of one revision (`tests/module-set.test.ts`). Two different revisions of one module reached through differently pinned imports both stay in the closure without a module-set diagnostic, and `compileYangModules` then reports a misleading `duplicate-node` per node (probed) — Stage 7b P1.
- [ ] Deadline and abort are only checked before each load; synchronous parsing of a large document cannot be interrupted (worker isolation remains the host's responsibility — see the P2 boundaries).

## Stage 2 — Semantic compiler and effective schema (partial)

Delivered: source-linked schema IR, grouping expansion with `refine`, choices/cases (explicit and shorthand), augments (data, RPC/action input/output, notification), deviations (`not-supported`, `add`, `replace`, `delete`), identities with cycle checks, `if-feature` filtering, nested actions, cardinality and type-restriction legality checks.

Open defects:
- [x] Nested nodes of a grouping defined in another module now inherit the instantiating module/namespace (`instantiatingModule` and inherited `when`/`if-feature` are forwarded to every expansion level), regression-tested in `tests/stage7-p0.test.ts` (2026-11-26).
- [x] Submodule context: data nodes, operations, augment and deviation statements of a submodule now resolve their `type`, `uses` and augment paths in the submodule's own document (its imports and its `belongs-to` prefix), keeping the parent module's namespace for schema identity; XPath prefix maps (`moduleNamespacePrefixes`) include the included submodules' imports and `belongs-to` prefixes (2026-11-26, `tests/stage7-p1.test.ts`).
- [x] `refine` of a `leaf` accepts `mandatory` (RFC 7950 §7.13.2) — the refined statement lands in the compiled node's properties, so `validateDataTree` reports `missing-mandatory` for the refined site only; `augment` inside `uses` expands into its (relative) target inside the grouping with the uses' `when`/`if-feature` inherited, additions in the instantiating module's namespace and duplicates reported (fixed 2026-11-26, `tests/stage7-p1.test.ts`).
- [ ] (closed for groupings, but regressed for data nodes — Stage 7b P0) Typedef and grouping lookup follows §6.2.1 scoping over a per-module-family index (O(1) top-level lookup): declarations nested in an enclosing grouping are visible only within it and shadow outer/top-level ones; a grouping's internals resolve prefixes in their declaring document (module or submodule) (fixed 2026-11-26, `tests/stage7-p1.test.ts`).
- [ ] `when` inherited through several levels is always evaluated at the immediate parent element (probed: false `when-unexpected-node` on valid data — Stage 7b P0).
- [ ] Not handled: `if-feature` on `enum`/`bit`, feature-to-feature dependencies (probed), deviations targeting RPC/action/notification nodes (probed), prefixed `refine`/`uses`-`augment` targets (probed), name uniqueness across choice cases — Stage 7b P1.

## Stage 3 — Type system and canonical values (partial)

Delivered: integer boundaries including exact 64-bit BigInt, decimal64 scaled arithmetic, string length/pattern, binary base64, enum/bits with derived restrictions, union in declaration order, canonical forms, leafref/identityref form-level checks, boundary corpus.

Open defects:
- [x] `pattern` with `modifier invert-match` inverts only its own pattern in the conjunction (fixed 2026-11-26, `tests/stage7-p0.test.ts`).
- [x] Patterns outside the proven-safe XSD/JS subset stay `pending` (fixed 2026-11-26): divergent escapes (`\d \D \w \W \s \S \p \P \i \c`), backreferences, `(?` groups, class subtraction, `[]` forms and out-of-class `^`/`$` never compile; shared logic lives in `src/types/xsd-pattern.ts` (test: `tests/stage7-p0.test.ts`).
- [ ] Unparsable `range`/`length` endpoints are treated as unbounded (constraint silently satisfied).
- [x] Type and builtin-name logic is single-sourced: `src/types/builtins.ts` owns `BUILTIN_TYPES` and `RESTRICTION_BUILTINS` (RFC 7950 §9/§9.2.1), locked by `tests/types-builtins.test.ts` (2026-11-26); the pattern compiler remains shared in `src/types/xsd-pattern.ts`.
- [ ] Canonical forms for identityref and instance-identifier are not represented.

## Stage 4 — XPath 1.0 and YANG evaluation context (partial)

Delivered: `xpath@0.0.36` adapter with unprefixed-name qualification, `current()`, the RFC 7950 function library, accessible trees (§6.4.1) and `must`/`when` evaluation.

Open defects:
- [x] The module's own `prefix` is in the prefix→namespace maps of must/when compilation, the leafref resolver and the identity library (`moduleNamespacePrefixes`, fixed 2026-11-26, `tests/stage7-p0.test.ts`). Qualification: typedef-declared leafref paths still use the *using* module's maps (Stage 7b P0).
- [x] Identityref values are resolved as `module-name:identity`; XML instances use arbitrary prefixes bound by namespace, so `ianaift:ethernetCsmacd` does not match (closed 2026-11-26, `tests/stage7-p1.test.ts`): `derived-from`/`derived-from-or-self` iterate the node-set and qualify each member's value through its own in-scope `xmlns` bindings (`xmlNamespaceForPrefix`), and form-level identityref checks resolve prefixes through the anchor element — a prefix bound to a namespace outside the schema stays invalid.
- [x] `enum-value` uses a schema-wide name→value table and throws on ambiguous names instead of resolving the argument node's own type (closed 2026-11-26, `tests/stage7-p1.test.ts`): RFC 7950 §10.5.1 semantics — the first node-set member's own enumeration type (through the typedef chain) decides the integer value; empty sets and non-enum nodes return NaN instead of consulting schema-wide names.
- [x] `buildAccessibleTree` (defaults of absent non-presence containers are still missing — Stage 7b P0): the datastore context node is now the datastore document with the data root as document element (RFC 6.4.1, fixed 2026-11-26), so absolute YANG paths resolve. Wrapper documents and inactive-case defaults closed 2026-11-26, `tests/stage7-p1.test.ts`: a wrapper document element (e.g. NETCONF `<data>`) is accepted and one accessible root per matching child — including each entry of a top-level list — is copied under a synthetic datastore element standing in for the §6.4.1 virtual root, so relative paths span all roots and cross-root references reach sibling roots (absolute paths still anchor at the document node, i.e. above the wrapper); case defaults follow RFC 7950 §7.9.3 — a case's defaults apply when the case itself is present or it is the choice's `default` case with nothing else present, so inactive cases never inject.
- [x] Compiled-expression caches are schema-scoped (`WeakMap<CompiledYangSchema, …>`) and the pattern text cache is bounded (cleared past 2048 entries), regression-tested by the cross-schema collision case in `tests/module-budgets.test.ts` (2026-11-26).
- [x] `qualifyYangXPathNodeTests` has a seeded differential/fuzz corpus (`tests/differential.test.ts`, 2026-11-26): pure-prefix-insertion invariant, bare-vs-prefixed spelling agreement over 300 generated expressions, curated tricky tokens, mutation-tested; see the Stage 7 P2 item.
- [ ] `instance-identifier` `deref` and metadata annotations remain unsupported (see `CONFORMANCE.md`).

## Stage 5 — Validation and conditional UI introspection (partial)

Delivered: `validateDataTree` (keys, unique, mandatory, cardinality, leafref, instance-identifier, `must`/`when`), form-level validation, `evaluateCandidates` with per-constraint reasons.

Open defects (several return *valid* where the result is unknown — highest priority):
- [x] Leafrefs declared through a typedef are checked (same-module context only: a typedef from another module is evaluated in the wrong prefix context and can make `validateDataTree` throw — Stage 7b P0): the resolver (and form-level cross-reference) reads the effective `path` from the own `type` or any `leafref` layer of the `typedefChain` (`leafrefPathStatementOf`, fixed 2026-11-26, `tests/stage7-p0.test.ts`).
- [x] `visitElement` descends into top-level `choice`/`case` (a choice nested in a case is still skipped and a mandatory nested choice reports a false `missing-mandatory` — Stage 7b P0): members get full constraint/cardinality evaluation, and a mandatory leaf of the active case is enforced while inactive cases impose nothing (fixed 2026-11-26, `tests/stage7-p0.test.ts`).
- [x] `unique` resolves each sub-path into (namespace, name) steps from the declaring module's prefix map, traverses direct children only, excludes entries missing a referenced leaf (§7.8.3) and checks every `unique` statement separately (fixed 2026-11-26, `tests/stage7-p0.test.ts`).
- [x] Validation evaluates the accessible tree, not the raw document (fixed 2026-11-26, `tests/stage7-p1.test.ts`): every matching root is validated through its own `buildAccessibleTree` datastore document — declared defaults are injected (`§7.6.1`), so `must` and leafref resolution see with-defaults content, and `includeState: false` hides `config false` subtrees instead of failing their mandatory nodes; the when-probe now mutates the internal accessible copy, never the caller's document.
- [ ] Mandatory descendants of absent non-presence containers are not enforced (probed; Stage 7b P0).
- [x] `FormField` validation no longer depends on a `WeakMap` keyed by object identity (fixed 2026-11-26, `tests/stage7-p1.test.ts`): every field carries a serializable `restrictions` descriptor (`ranges`, `lengths`, `patterns` with `invert-match`, `fractionDigits`, `bases`, `bits` with positions, precomputed `unionMembers`), so shallow copies, clones and reactive proxies keep validating range/length/pattern/fraction-digits.
- [x] `findSchemaNodeByPath` strips one trailing `[*]` predicate per path segment, so form fields under lists reach their schema node and leafref cross-reference checks no longer stay `pending` (fixed 2026-11-26, `tests/stage7-p1.test.ts`).
- [x] Leaf-lists of leafref/identityref are validated entry by entry against the cross-reference context instead of erroring on the array; union leaf-lists validate through the precomputed union member descriptors (including their restrictions) instead of staying `indeterminate`; per-entry errors carry an `(entry N)` suffix (fixed 2026-11-26, `tests/stage7-p1.test.ts`).
- [ ] `createFormModel` is a parallel, parse-tree-based path that ignores `uses`, augments, features, deviations and choice exclusivity (mandatory leaves in a case are marked `required` regardless of the active case). Rebuild it on `CompiledYangSchema`.
- [x] `evaluateCandidates` (still evaluates the raw clone rather than the accessible tree, sorts bits alphabetically and ignores enum/bit `if-feature` — Stage 7b P1) locates the target through a segment-by-segment schema chain: choice/case segment names are tolerated, each segment is checked against its own schema namespace (augmented ancestors are found) and key predicates such as `[name='core']` select a specific list entry; probing runs on a private clone of the instance document so the caller's document is never mutated (empty elements previously kept the last candidate value); ancestor and present-sibling `must`/`when` constraints that reference the node are folded into each candidate's verdict (fixed 2026-11-26, `tests/stage7-p1.test.ts`).

## Stage 6 — Browser release readiness (partial)

Delivered: browser-readiness source audit, conformance matrix and versioning policy, YANG Library/RESTCONF loading adapter, resource budgets for loading, release workflow, standalone example build.

Open defects:
- [x] Real-browser run in place (P3, 2026-11-26; its skip when Chromium is missing is broken — Stage 7b P1): `tests/real-browser.test.ts` drives `examples/standalone.html` in headless Chromium (Playwright, devDependency only) so the bundled engine runs with the browser's own DOM. The Node suites keep `@xmldom/xmldom` for the DOM.
- [x] `npm test` is self-sufficient via a `pretest` build (closed 2026-11-26, `package.json`); README and `TESTING.md` updated to match.
- [x] Tests are type-checked: `npm run typecheck` runs both `tsconfig.json` (src) and `tsconfig.tests.json` (src + tests, `@types/node`; closed 2026-11-26, latent type errors fixed in the same pass).
- [ ] RESTCONF loader (partly closed; the RFC 8525 submodule/import-only layout is wrong — Stage 7b P1) requests the library under the RFC 8040 `/data/` subtree by default (absolute URLs and pre-qualified `data/`/`operations/` resources pass through), reads the RFC 8525 nested `submodule` lists (with a fallback to flat rows for RFC 7895 payloads), accepts the RFC 7895 `schema` leaf as a source URL before the `yang?module=` probe, and forwards an `AbortSignal` to every request (`yangLibraryInventory`, fixed 2026-11-26, `tests/restconf-loader.test.ts`).
- [x] Public surface curated (closed 2026-11-26, `tests/public-api.test.ts`): `src/index.ts` re-exports exactly the documented API with honest `capabilities` values; internal helpers live behind `src/internal.ts`.
- [x] Documentation drift removed (2026-11-26): README's Status and form-model claims, `ARCHITECTURE.md`'s layout and debt list, `CONFORMANCE.md` rows and this file now agree with the code; the resource-budgets row states the enforced `maxDepth`.

## Stage 7 — Correctness and hardening debt (open)

New stage collecting the review findings by priority. Each item is closed by a failing test first, then the fix, then the matching `CONFORMANCE.md` row.

**P0 — wrong "valid" or wrong namespaces — all closed 2026-11-26, each by a regression in `tests/stage7-p0.test.ts` that failed before its fix**
- [x] Leafref through typedef (Stage 5).
- [x] `choice`/`case` descent in `validateDataTree` (Stage 5).
- [x] `unique` semantics (Stage 5).
- [x] Cross-module grouping namespace/`invalid-key` (Stage 2).
- [x] Own-prefix in XPath maps (Stage 4) — plus the datastore accessible-tree context node/root fix that made absolute YANG paths evaluable.
- [x] `pattern`: `invert-match` evaluated inverted and XSD/JS divergences kept `pending` (Stage 3).
- [x] `maxDepth` enforced (Stage 1).

**P1 — correctness of secondary paths**
- [x] Parser: string tokens vs `;`/`{`, escapes, indentation stripping, empty arguments (Stage 0) — closed 2026-11-26 by regressions in `tests/stage7-p1.test.ts` against RFC 7950 §6.1.3: quoted arguments compare token kinds; escapes `\n \t \" \\` transformed, other backslashes rejected; multi-line double-quoted strings strip trailing whitespace and indentation up to the opening quote's column (tabs = 8 spaces); empty-string arguments kept distinguishable; adjacent quoted strings without `+` rejected while unquoted word lists (`key a b c`) still join with spaces; end-of-input errors report the end of the source; statement nesting capped at depth 200.
- [x] Submodule compilation context (Stage 2) — closed 2026-11-26, see Stage 2.
- [x] Validate on the accessible tree (defaults, config/state) (Stage 5) — closed 2026-11-26, see Stage 5.
- [x] `FormField` restriction descriptor; `[*]` path mismatch; leaf-list cross-references (Stage 5) — closed 2026-11-26 by regressions in `tests/stage7-p1.test.ts` against RFC 7950 §6.2.1/§9.9/§9.10: fields carry a serializable `restrictions` descriptor so copies and proxies keep range/length/pattern/fraction-digits (a `WeakMap` lost them); `findSchemaNodeByPath` strips `[*]` per segment; leaf-lists of leafref/identityref validate entry by entry with `(entry N)` errors and union leaf-lists pick up member restrictions.
- [x] `evaluateCandidates` location, entry targeting and non-mutation (Stage 5) — closed 2026-11-26, see Stage 5.
- [x] `refine` `mandatory`; `augment` under `uses`; typedef/grouping scoping and index (Stage 2) — closed 2026-11-26, see Stage 2.
- [x] RESTCONF loader paths and submodule lists (Stage 6) — closed 2026-11-26, see Stage 6.
- [x] Namespace-aware identityref resolution for XML; `enum-value` by node type (Stage 4) — closed 2026-11-26, see Stage 4. The accessible-tree rebuild now also re-declares the instance's `xmlns` bindings so `must`/`when` evaluation keeps resolving XML prefixes.
- [x] Accessible tree: wrapper documents, inactive-case defaults (Stage 4) — closed 2026-11-26, see Stage 4.

**P2 — hardening for untrusted modules**
- [x] Budgets beyond loading (all opt-in with no defaults; no XPath step/time budget exists — Stage 7b P2): grouping/`uses` expansion node count, XPath evaluation steps/time, regex execution (ReDoS), parser nesting depth, CPU cancellation (worker + timeout) — closed 2026-11-26 by tests in `tests/module-budgets.test.ts`: `compileYangModules({ budget: { maxSchemaNodes } })` stops grouping/`uses` fan-out with one `budget-exceeded` diagnostic; `validateDataTree` and `evaluateCandidates` take an `options.signal` and report `indeterminate` + `cancelled` when aborted; patterns longer than 256 characters, with quantifier bounds ≥ 1000 or with the nested-unbounded-quantifier ReDoS shape stay `pending`; parser nesting was already capped at depth 200 (Stage 0). Boundary made explicit: a single XPath cannot be interrupted mid-expression in the synchronous third-party evaluator — input size is bounded by the source-character budget and long stores need worker isolation at the host.
- [x] Schema-scoped caches (`WeakMap<schema, …>`) instead of module-level maps — closed 2026-11-26 by a collision regression in `tests/module-budgets.test.ts` that failed before the fix: two schemas reusing the same module name compiled each `must` once for the first schema and wrongly reused that compiled path for the second; `compileModuleExpression` now scopes `WeakMap<CompiledYangSchema, Map<"module:expression", …>>` per schema and releases with it. The text cache for pattern compilation (`src/types/xsd-pattern.ts`) is bounded — cleared once past 2048 entries — since untrusted modules can mint unlimited distinct patterns.
- [x] XPath-rewrite fuzz corpus — a self-consistency check between two spellings of the same expression, not a comparison against libyang despite the file name — closed 2026-11-26 by `tests/differential.test.ts`: a seeded (mulberry32, reproducible) fuzz corpus of 300 grammar-generated expressions, each evaluated in two spellings — unprefixed through `compileYangXPath` and explicitly `if:`-prefixed through the imported-namespace map — asserting the rewrite is a pure prefix insertion (stripping the auto prefix restores the source byte for byte), both spellings compile, and every accessor (select/number/string/boolean) agrees regardless of spelling; a curated corpus asserts the nearest WRONG rewrite characters (qualifying `string`, `current`, functions, axes, operators `div`/`mod`/`and`/`or`, `@`) never appear, and quoted literals containing the reserved auto prefix force it aside without breaking evaluation. The corpus was exercised against a mutation (dropping the operator guard) and fails as intended. The libyang half stays deferred: yanglint/libyang is not available in the development environment and is never a browser runtime option (see `ARCHITECTURE.md`); when a development CI can install it, `TESTING.md` §9 keeps the triage policy (differences resolved against RFC semantics).

**P3 — project hygiene**
- [x] Documentation aligned (first pass 2026-11-26; some statements were stale or overstated afterwards and were corrected by the re-review pass): README's Status and form-model claims, `ARCHITECTURE.md`'s module layout and debt list, `TESTING.md` and this file agree with the code; `CONFORMANCE.md` keeps every row with an open stage defect at *partial* (resource budgets, groupings/uses, deviations, identity/feature evaluation, union, leafref/identityref and instance-identifier integrity, canonical forms, structural checks, forms, instance-identifier deref) with the concrete open defect named in its stage section.
- [x] Curate `src/index.ts` into named exports; move helpers to an internal entry point — closed 2026-11-26 by `tests/public-api.test.ts` (red first: the barrel exported everything). The published surface is exactly the documented API (core pipeline, form helper, data-tree validation, the network-free RESTCONF helpers and their types) with `capabilities` reporting honest values (`parser`/`moduleResolution`/`xpath` implemented, `validation` partial); internal helpers (XPath rewrite/tooling, AST walkers, YANG Library inventory, the built-in type registry) live in `src/internal.ts` for tests and deep imports, and the smoke suite pins that `dist/index.d.ts` still names everything the examples import.
- [x] Real-browser test run; type-check tests; make `npm test` self-sufficient; add `prepack` — closed 2026-11-26. `npm run typecheck` runs both `tsc --noEmit` sources and `tsconfig.tests.json` (src + tests, `@types/node`, one documented xmldom→dom cast in `tests/dom.ts`); a sweep fixed the latent type errors it exposed (hunt-down xmldom typing bridges in every suite, `loadModule` missing on a loader stub, vitest-4 incompatible `expect(value, message)`/`toMatch` message arguments). `npm test` is self-sufficient through a `pretest` build, and `prepack` builds before publishing. The real-browser run is `tests/real-browser.test.ts`: Playwright headless Chromium loads `examples/standalone.html` over a local server (page renders the oven form without page errors; the engine compiles and validates a data tree inside the page using the browser's own DOMParser), and the suite announces a clear skip when `playwright install chromium` was not run on a dev machine. Playwright is a devDependency only, never a runtime dependency.
- [x] Shared `types/` code extracted and the duplicated builtin logic removed (closed 2026-11-26 — `src/types/builtins.ts`, `tests/types-builtins.test.ts`, first committed in the same review; `src/types/xsd-pattern.ts` was already shared).

## Stage 7b — Findings of the post-fix re-review (open)

Evidence: *(probed)* = reproduced by running the sources (type-checked copy of `src/`, throw-away Vitest probes); *(read)* = from code reading, still to be confirmed by a test. None of these tests exists in the repository yet. Each item is closed by a failing test first, then the fix, then the matching `CONFORMANCE.md` row.

**P0 — wrong verdicts, exceptions, regression**
- [ ] *(probed, regression of the Stage 2 scoping fix)* Typedefs and groupings declared inside a `container`, `list`, `rpc`, `action`, `notification`, `input` or `output` report `unresolved-type` / `unresolved-grouping`. `findSymbol` only consults enclosing groupings and the module-family top level, and `makeNode` never pushes the declaring data node as a scope; before the fix the whole-tree search found them. RFC 7950 §6.2.1 scopes a nested definition to its parent statement and that statement's descendants.
- [ ] *(probed)* A leafref declared through a typedef is compiled in the *using* module's prefix/namespace context instead of the typedef's declaring module. A typedef of module `lib` (path `/l:items/l:item/l:name`) used from a module that imports `lib` as `other` makes `validateDataTree` throw `Cannot resolve QName l`; an unprefixed typedef path is qualified with the using module's namespace and reports a false `leafref-dangling`. Carry each typedef's declaring document with `typedefChain` and compile the path there; `createLeafrefResolver` must catch compile/evaluation errors and report `indeterminate`, so `validateDataTree` never throws.
- [ ] *(probed)* A `when` inherited through two or more levels (`container a { when "../mode = 'on'"; container b { leaf c … } }`) is evaluated at the immediate parent of `c`, giving a false `when-unexpected-node` on valid data. Evaluate each inherited `when` at the element of the node that declared it (RFC 7950 §7.21.5), and augment/`uses` whens at their target.
- [ ] *(probed)* A `choice` nested in a `case`: a mandatory nested choice reports a false `missing-mandatory`, and the members of nested choices are never visited (a violated `must` returns `valid`). Case members go through `visitChildNode`, which only knows data nodes; only the top-level branch of `visitElement` handles `choice`.
- [ ] *(probed)* Non-presence containers: mandatory descendants of an absent one are not enforced (RFC 7950 §7.6.5), and declared defaults inside it are not injected into the accessible tree (§7.6.1), so a `must` that reads such a default is falsely unmet.

**P1**
- [ ] *(probed against the module)* YANG Library layout. In RFC 8525 (`ietf-yang-library@2019-01-04`) `submodule` is a list nested in each `module` and `import-only-module` entry, and import-only modules form their own list. `yangLibraryInventory` reads a `submodule` list beside `module` and ignores `import-only-module`; the nested `submodule` lists of RFC 7895 are ignored too, and `tests/restconf-loader.test.ts` encodes the same non-RFC shape. NMDA servers therefore lose their submodules and import-only modules (typically the type libraries).
- [ ] *(probed)* The real-browser suite detects Chromium with `chromium.executablePath()`, which returns the expected path even when the browser is not installed (the file does not exist), so without `playwright install chromium` the suite fails at `launch()` instead of announcing its skip. Check that the file exists.
- [ ] *(probed)* Feature-to-feature dependencies: a feature whose own `if-feature` is disabled still counts as enabled.
- [ ] *(probed)* Deviations targeting RPC/action/notification parameter nodes are reported unresolved.
- [ ] *(probed)* `refine` and `uses`/`augment` targets are matched by plain name, so a prefixed target (`refine m:a`) is reported unresolved.
- [ ] *(probed)* Two revisions of one module in a closure: no module-set diagnostic, then one `duplicate-node` per node at compile time. Decide and document the policy (RFC 7950 §5.6.5: imported revisions may differ, only implemented modules must be unique) and diagnose accordingly.
- [ ] *(read)* `evaluateCandidates` evaluates a raw clone, not the accessible tree (defaults missing); the bits candidate string is sorted alphabetically while `canonicalFormOf` orders by bit position; `if-feature` on `enum`/`bit` is ignored by `finiteDomainOf` and by form options.
- [ ] *(read)* `moduleNamespacePrefixes` merges a module's and its submodules' imports into one map, so an expression can use a prefix declared only by a sibling document.
- [ ] *(read)* `instance-identifier` steps and predicates are matched by local name only (documented limitation).

**P2**
- [ ] Safe defaults: every budget is opt-in (`maxSchemaNodes`, loading limits, signals). Provide a preset or documented values for untrusted modules; add an XPath step/time budget; regex execution relies on the pending guards only; `resolveModuleSet` checks its deadline between loads only.
- [ ] Conservative pattern subset: `\d`, `\w`, `\s` and `\p{…}` are always `pending`, so leaves constrained by them (for example through the zone suffix of the `ietf-inet-types` address patterns) end `indeterminate`. A real XML Schema → JavaScript translator (Unicode classes, `u` flag semantics, character-class subtraction) would let them validate.
- [ ] An independent oracle (libyang/yanglint) as a development-only differential check is still absent.
- [ ] *(read)* Parser leniency: the statement loop compares token *values*, so a quoted string `"}"` in statement-start position closes the block instead of being a syntax error.

## Stage 8 — Next.js static-export integration (planned)

Goal: use the engine in a Next.js site built with `output: 'export'`, served as static files, where the whole application runs in the browser and talks to a RESTCONF API (RFC 8040, optionally RFC 8527 NMDA). The core stays framework-neutral; Next.js and React support live in optional entry points and an example app.

Static-export constraints that shape the design (verify against the current Next.js documentation when starting):
- No server runtime: no API routes or middleware, no `rewrites`/`redirects`/`headers`, no ISR, no default image optimizer (`images.unoptimized`). Anything data-dependent must run on the client.
- Pages are prerendered at build time, where there is no DOM, no `DOMParser` and no RESTCONF server. The engine must be import-safe in that environment and initialized only on the client.
- Dynamic routes need `generateStaticParams`; routes that depend on runtime data (a data-node path, a list key) must use search parameters or the hash, not path segments.
- `NEXT_PUBLIC_*` values are inlined in the public bundle: no secrets, tokens or credentials at build time.
- Calls to the RESTCONF API are cross-origin unless the static files are served from the same origin or behind the same reverse proxy. Without Next.js rewrites, deployment must provide either CORS on the RESTCONF server (allowed origin, `Authorization`/`Content-Type`/`Accept` headers, `PUT`/`PATCH`/`DELETE`/`OPTIONS`, exposed `ETag`/`Location`/`Last-Modified`) or same-origin hosting. This is a server-side prerequisite, documented but outside the package. HTTPS pages cannot call plain-HTTP APIs (mixed content).
- `basePath`/`assetPrefix` must be configurable for sites served under a sub-path of the device or gateway.

**Dependencies on earlier stages (blockers).** Do not build the adapters before these Stage 7 items close, because React state management triggers exactly the failure modes they describe:
- [x] Serializable `FormField` restriction descriptor (P1) — closed 2026-11-26, see Stage 5.
- [x] Validation and candidate evaluation on the accessible tree without mutating the caller's document (P0/P1) — both closed 2026-11-26, see Stage 5.
- [x] Leafref via typedef, validation under `choice`/`case`, `unique`, own-prefix XPath, cross-module groupings (P0) — all closed 2026-11-26, see the per-stage items.
- [x] RESTCONF loader fixes: `/data/` URL shape, nested submodule lists, RFC 7895 `schema`, `AbortSignal` (P1) — closed 2026-11-26, see Stage 6.
- [x] Curated named exports with `sideEffects: false` (P3, closed 2026-11-26 — `tests/public-api.test.ts`), so the Next.js bundle only contains what the page imports.
- [ ] Stage 7b P0: a UI that surfaces verdicts needs `validateDataTree` to never throw and never report *invalid* for valid data (cross-module typedef leafrefs, multi-level `when`, nested choices, data-node typedef/grouping scopes).
- [ ] Stage 7b P1: the YANG Library loader layout (RFC 8525 nested `submodule` lists, `import-only-module`), because the Next.js client relies on discovery through the library.
- [x] Budgets beyond loading plus cooperative cancellation for untrusted modules (P2, closed 2026-11-26 — `tests/module-budgets.test.ts`); opt-in only, and a single XPath cannot be interrupted synchronously — long-running stores need the host's worker isolation (documented boundary).

**8.1 Build-time precompilation (optional, recommended).**
- [ ] Serializable schema: a stable JSON form of `CompiledYangSchema` (no `YangStatement` object graph or DOM references) with a version number, so compilation can happen at build time and the browser only loads the result.
- [ ] CLI/script (for example `yang-browser-engine precompile`) that takes YANG sources and enabled features and writes the serialized schema and module texts into `public/`; usable from an npm script before `next build`.
- [ ] Runtime fallback that fetches the YANG Library from the device and compiles in the browser (the loader path), for devices whose models are not known at build time. The page chooses precompiled or discovered schema explicitly; a mismatch between the precompiled revision and the device's YANG Library revision is detected and reported.

**8.2 RESTCONF JSON bridge (framework-neutral, optional entry).**
- [ ] RFC 7951 JSON ↔ instance-tree adapter: module-qualified names at namespace changes, 64-bit integers and decimal64 as strings, `empty` as `[null]`, identityref/instance-identifier encodings, `bits` as space-separated strings. Today validation runs only on DOM documents, so RESTCONF JSON responses cannot be validated or used to prefill forms without this layer.
- [ ] Inverse direction: form values and edited trees to RFC 7951 JSON bodies (and to `YangPathSegment` paths for the existing request builders).
- [ ] Tests with RFC 7951 examples and round trips against the fixture corpus.

**8.3 Browser RESTCONF client (framework-neutral, optional entry).**
- [ ] `createRestconfClient({ baseUrl, fetch, headers/auth, signal })` that executes the requests produced by the existing builders through an injectable `fetch`; no direct global access at import time.
- [ ] Authentication hooks: bearer/basic via a header provider callback, cookie sessions via `credentials`; token storage is the application's job, with guidance in the docs (in-memory preferred over `localStorage`; no tokens in `NEXT_PUBLIC_*`).
- [ ] Response handling: `application/yang-data+json`, `ietf-restconf:errors` (error-type, error-tag, error-path, error-message) mapped to typed errors and, where possible, to form field paths; `Location` on `POST`; `ETag`/`If-Match` and `Last-Modified`/`If-Unmodified-Since` for edit conflicts (409/412); `204` handling; plain `PATCH`.
- [ ] Query parameters (`content`, `depth`, `fields`, `filter`, `with-defaults`, `with-origin`), pagination-style `depth` browsing for large lists, and the NMDA datastore probe.
- [ ] Cancellation (`AbortSignal`), timeouts and retry policy for idempotent methods only.
- [ ] Optional: RESTCONF notification streams over `EventSource` (RFC 8040 §6), with reconnect and cleanup.
- [ ] CORS diagnostics: a failed preflight/opaque error is reported with a hint rather than as a generic network failure.

**8.4 React bindings (optional entry, `"use client"`).**
- [ ] Headless, UI-kit-agnostic API: `YangProvider`, `useYangSchema`, `useFormModel`, `useFieldValidation`, `useDataValidation`, `useCandidates`, `useRestconfResource`. State shape is plain serializable data, safe under React strict mode, concurrent rendering and devtools.
- [ ] The provider initializes the engine in an effect (or via `next/dynamic` with `ssr: false`); the first server/prerender render shows a loading state and hydrates without mismatch.
- [ ] Validation and compilation run in a Web Worker (`new Worker(new URL(...), import.meta.url)`) with cancellation and a main-thread fallback; results are structured-cloneable.
- [ ] Optimistic edit flow: edit → validate locally (valid/invalid/indeterminate with reasons) → send `PATCH`/`PUT` → reconcile with server errors and refreshed data; `indeterminate` results never block submission silently, the server stays the authority.
- [ ] Selection of the active case of a `choice` and list-entry targeting in the binding API (depends on the form-model rebuild on the compiled schema).

**8.5 Next.js configuration helper and recipe.**
- [ ] `withYangEngine(nextConfig)` (or a documented snippet) that sets `output: 'export'`, `images.unoptimized`, `transpilePackages` if needed, `basePath`/`assetPrefix` passthrough, and worker/asset handling for the precompiled schema.
- [ ] Routing guidance: client-side navigation with search parameters or hash for data-node paths; `useSearchParams` wrapped in `Suspense`; `trailingSlash` and static hosting notes.
- [ ] Guidance for both App Router and Pages Router (client-only components; no Server Components touching the engine).
- [ ] Content-Security-Policy notes: the engine uses no `eval`/`new Function`; document the `connect-src` entries needed for the RESTCONF origin.

**8.6 Example app and verification.**
- [ ] `examples/next-static/`: a Next.js app with `output: 'export'` that loads a YANG Library from a RESTCONF API, renders forms for configuration and RPCs, validates, and edits data. Build output (`out/`) must contain no server runtime.
- [ ] Mock RESTCONF server for development and CI (in-memory, supports `GET`/`POST`/`PUT`/`PATCH`/`DELETE`, errors, `ETag`, CORS toggle).
- [ ] Real-browser end-to-end tests (Playwright) against the exported site and the mock server. This also closes the Stage 6 gap of having no real-browser suite.
- [ ] Bundle-size budget for the engine chunk, checked in CI; the engine is loaded with dynamic `import()` so pages that do not use it do not pay for it.
- [ ] Test that `next build` prerenders every page without touching `window`, `document`, `DOMParser` or `fetch`.

Exit: the example app builds with `next build` into a static `out/`, runs from a static host (including under a `basePath`), discovers or loads a schema, validates and edits data against a RESTCONF API, and passes the Playwright suite; every blocker listed above is closed; `CONFORMANCE.md` has rows for the JSON bridge and the client with their covering tests.

## Principles

- Syntax recognition is not semantic support; unsupported constructs must be explicit.
- Unknown is never "valid": an unevaluable or unsupported check yields `indeterminate`/`pending` with a reason, never a silent pass.
- Every semantic feature needs an RFC reference and focused regression tests, including a negative case.
- A roadmap stage is only "done" when its listed defects are closed by tests.
- Core accepts module text and configuration; transport and UI frameworks stay at the edges. Next.js, React and RESTCONF client code ship as optional entry points and never become dependencies of the compiler or validators.
- libyang can be a development-time differential oracle, never a runtime requirement in the browser.
