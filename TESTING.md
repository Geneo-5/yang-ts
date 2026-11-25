# Test strategy

The goal is to prove behavior by layer and to prevent partial support from looking like full support. Every semantic test should link to an RFC section or an identified real-world fixture and state whether it is positive, negative or intentionally indeterminate. A feature whose "unknown" case would return *valid* is a test gap: unevaluable checks must assert `indeterminate`/`pending`.

## Current gates

`tests/bundle-smoke.test.ts` imports the built `dist/index.js`, so the build must run before the full suite on a clean checkout (`dist/` is git-ignored):

```sh
npm install
npm run build
npm test
npm audit --omit=dev
```

Running `npm test` before the first build fails in the bundle-smoke suite by design; the other suites do not need `dist/`.

Coverage as of 2026-11-26: parser, module resolver, compiler, type boundaries/canonical forms, XPath adapter and function library, accessible trees, constraints, data-tree validation, candidates, cross-references, the RESTCONF loader and the browser-readiness source audit all have test files. Full statement validation remains uncovered. A review of the sources (see `ROADMAP.md`, Stage 7) found defects in several of these layers; the corresponding cases are not yet written, so a green run does not mean the listed defects are absent.

## Regression tests owed by the review

Each item must be written first as a failing test, then fixed. Priorities follow `ROADMAP.md` Stage 7.

- **P0**: leafref declared through a typedef is checked (and a dangling one is reported); `validateDataTree` visits nodes under `choice`/`case`; `unique` with multi-step and prefixed paths, and with entries missing a leaf; a list inside a grouping defined in another module compiles without `invalid-key` and with the instantiating module's namespace; `must`/`when`/leafref using the module's own prefix; `pattern` with `modifier invert-match`; XSD-only pattern syntax (`\p{L}`, `^`/`$`) stays `pending`; `maxDepth` stops resolution.
- **P1**: submodule-only imports resolve for the submodule's own nodes; parser accepts `default ";";`, translates `\n`/`\t`, strips multi-line indentation and keeps `default ""`; validation sees defaults through the accessible tree; a cloned or spread `FormField` keeps its restrictions; leafref cross-reference checks under lists; leaf-lists of leafref/identityref/union; `evaluateCandidates` for augmented nodes, nodes under choices and a chosen list entry, with the document left unchanged; `refine` `mandatory` on a leaf; RESTCONF loader URL, nested submodules and RFC 7895 `schema`; XML identityref prefixes; `enum-value` with ambiguous names.
- **P2**: budget tests for grouping expansion, XPath evaluation, regex execution and parser nesting depth.

## Test layers

1. **Lexer/parser** — every statement form, comments, escaped and concatenated strings (including multi-line double-quoted strings and `\n`/`\t`), quoted `;`/`{`/`}` arguments, empty arguments, whitespace, malformed delimiters, unterminated strings/comments, precise line/column diagnostics, nesting depth. Parse the real fixture corpus on every change.
2. **Module set** — imports/includes with pinned and unpinned revisions, submodules, multiple revisions, missing dependencies, duplicate modules, cycle diagnostics, budgets (modules, submodules, depth, source size, deadline, abort). Assert the exact resolved dependency closure. Covered by `tests/module-set.test.ts` and `tests/module-budgets.test.ts`; `maxDepth` and malformed metadata remain.
3. **Semantic compiler** — statement legality/cardinality, namespaces/prefixes (including cross-module groupings and submodule context), typedef inheritance and scoping, uses/refine/uses-augment, effective list keys, explicit and implicit choice cases, augment path/target/child resolution, feature gates and deviations. Check both compiled tree shape and source provenance (`tests/compiler.test.ts`).
4. **Types** — boundaries and canonical values for every built-in type and restriction; enum/bit numbering; union branch selection; exact 64-bit and decimal parsing; derived restrictions and defaults; `invert-match`; XSD regular-expression syntax that JavaScript would misread. Form-level cases live in `tests/forms.test.ts`, `tests/boundaries.test.ts`, `tests/canonical.test.ts`.
5. **XPath** — XPath 1.0 behavior, YANG name resolution (own prefix, imported prefixes), axes/predicates/coercions, node-set comparison, all YANG functions, `current()`, absent nodes, defaults, each accessible-tree context. Add a differential/fuzz corpus for `qualifyYangXPathNodeTests`. Current coverage: `tests/xpath.test.ts`, `tests/accessible-tree.test.ts`, `tests/constraints.test.ts`.
6. **Constraints and validation** — `must`, `when`, leafref, instance-identifier, mandatory, choices, keys, unique and cardinality. Test valid/invalid/indeterminate separately and test dependency ordering/cycle reporting for `when`. Include nodes under choices, nested `when` inheritance and absent non-presence containers.
7. **UI-facing API** — candidate enum filtering with complete data context, dynamic re-evaluation when siblings change, unresolved context handling, explanatory reasons; form validation on copied/proxied fields and on fields under lists. Include examples that prevent unsafe static filtering.
8. **Browser integration** — smoke-test ESM exports in a real browser, assert no Node globals or native/WASM/Python requirements, check cancellation and limits, and verify no cross-origin assumptions in the core. Status: only a Node-side source audit and a Node import of `dist` exist (with `@xmldom/xmldom` as the DOM); a real-browser run (Vitest browser mode or Playwright) is not yet in place.
9. **Differential/interoperability** — compare supported compiler and validation cases with libyang in development CI where available. Differences must be triaged against RFC semantics, not blindly copied from the oracle. Not yet in place.

## Fixture corpus policy

- Keep `oven.yang` as the quick, readable smoke model.
- Keep RFC 8343/8344 plus the exact imported type modules and IETF interface extension modules as the integration corpus.
- Record origin, revision, license notice and dependency graph in `tests/fixtures/yang/README.md` whenever adding a fixture.
- Add fixtures for uncovered constructs (e.g. cross-module groupings, submodules with their own imports, choices with lists and `must`, typedef-wrapped leafrefs, `unique` over nested paths, `invert-match` patterns, deviations, feature expressions, identity inheritance, leafref predicates, `must`/`when` context) instead of growing one untraceable mega-fixture.
- Do not vendor generated config data as schema input; keep instance data fixtures separate from YANG modules.

## Test tooling gaps

- `tsconfig.json` includes only `src`, so tests are transpiled by Vitest but never type-checked. Add a test tsconfig and a `tsc --noEmit` step.
- Tests run under Node; DOM differences between `@xmldom/xmldom` and browsers (for example `parentElement`) are not exercised.
- The RESTCONF loader tests use a simulated `fetch`; URL shapes against a real RESTCONF server are unverified.

## Coverage reporting

Maintain a matrix with four states: **implemented**, **partial**, **unsupported**, **untested** (`CONFORMANCE.md`). A parser test only upgrades syntax coverage. A feature is "implemented" only after semantic behavior and negative cases are covered and no known defect is open. A CI failure should include the fixture path, statement location and expected diagnostic where available.

## Release workflow (repeatable)

Every release follows the same gates, in order; a release with any red gate does not ship.

1. `npm run build` — `tsc` must be clean; `dist/index.js` and `dist/index.d.ts` are the only shipped artifacts (the build also regenerates `examples/standalone.html`).
2. `npm test` — the full suite (parser, module-set with budgets/cancellation, compiler, boundary and canonical corpora, XPath/constraints, validation, candidates, cross-references, RESTCONF adapter, browser-readiness audit, bundle smoke). The audit and the smoke suite now run against the freshly built `dist`.
3. `npm audit --omit=dev` — zero known vulnerabilities in runtime dependencies.
4. Update `CONFORMANCE.md` rows for anything the release changes (a row without its covering test regresses to `untested`; a row with an open defect stays `partial`), and `ROADMAP.md` for stage status.
5. Visual check: serve the repo root over localhost (e.g. `python3 -m http.server`) and open `examples/browser-usage.html` in a current browser; the oven RPC preview must render and validate through `dist/index.js`. This is the manual leg of browser testing; until a real-browser suite exists it is the only one.
6. `npm pack --dry-run` and check the archive: only `dist`, `examples`, docs; no sources, fixtures or tests leak into the tarball. There is no `prepack` hook yet, so verify `dist/` exists before publishing.

Versioning and diagnostics policy for releases is documented in `CONFORMANCE.md`.
