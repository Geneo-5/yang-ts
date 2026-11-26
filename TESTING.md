# Test strategy

The goal is to prove behavior by layer and to prevent partial support from looking like full support. Every semantic test should link to an RFC section or an identified real-world fixture and state whether it is positive, negative or intentionally indeterminate. A feature whose "unknown" case would return *valid* is a test gap: unevaluable checks must assert `indeterminate`/`pending`.

## Current gates

`tests/bundle-smoke.test.ts` imports the built `dist/index.js`, so the build must run before the full suite on a clean checkout (`dist/` is git-ignored):

```sh
npm install
npm run build
npm test
npm audit
npm run next-static:e2e
npm run next-static:e2e:basepath
```

Running `npm test` works on a clean checkout: a `pretest` hook builds `dist/` first. `tests/real-browser.test.ts` additionally needs `npx playwright install chromium` (dev-time only) and announces its own skip when it is absent.

Coverage as of 2026-11-26: parser, module resolver, compiler, serialization + precompile CLI, type boundaries/canonical forms, XPath adapter and function library, accessible trees, constraints, data-tree validation, candidates, cross-references, the RESTCONF loader/client/JSON adapter, React hooks and worker, browser-readiness audit, and a real HTTP mock RESTCONF server all have test files. The mock server is exercised over ephemeral localhost ports in `tests/mock-restconf-server.test.ts` for CRUD, YANG Library and YANG source discovery, ETags, typed errors and CORS. The Next.js 16.4.6 static export is built and audited by `scripts/check-next-static.mjs`; `scripts/next-static-e2e.mjs` drives schema discovery, invalid-value rejection, PATCH persistence and RPC invocation in Chromium at the root and under `/yang-console`. `.github/workflows/ci.yml` runs both configurations. Statement-legality breadth and real-server URL shapes remain uncovered.

## Review regressions: landed

The Stage 7/7b backlog (P0→P2) landed on 2026-11-26: every item was written first as a failing test (`tests/stage7-p0.test.ts`, `tests/stage7-p1.test.ts`, `tests/stage7b-p0.test.ts`, `tests/stage7b-p1.test.ts`, plus `tests/module-budgets.test.ts` for the budgets and `tests/differential.test.ts` for the rewrite corpus), then fixed, then matched to its `CONFORMANCE.md` row. The convention stays in force for any future fix: failing test first, fix second, matrix row third. The Stage 8.4 optimistic-edit flow followed the same path on 2026-11-26 (`tests/optimistic-edit.test.ts`, red first, then green, flushing out the top-level-leaf gaps in the bridge and the builders).

## Test layers

1. **Lexer/parser** — every statement form, comments, escaped and concatenated strings (including multi-line double-quoted strings and `\n`/`\t`), quoted `;`/`{`/`}` arguments, empty arguments, whitespace, malformed delimiters, unterminated strings/comments, precise line/column diagnostics, nesting depth. Parse the real fixture corpus on every change.
2. **Module set** — imports/includes with pinned and unpinned revisions, submodules, multiple revisions, missing dependencies, duplicate modules, cycle diagnostics, budgets (modules, submodules, depth, source size, deadline, abort). Assert the exact resolved dependency closure. Covered by `tests/module-set.test.ts` and `tests/module-budgets.test.ts`; `maxDepth` is enforced since 2026-11-26, and one `duplicate-revision` per conflicting module name replaces the per-node flood (`tests/module-set.test.ts`).
3. **Semantic compiler** — statement legality/cardinality, namespaces/prefixes (including cross-module groupings and submodule context), typedef inheritance and scoping, uses/refine/uses-augment, effective list keys, explicit and implicit choice cases, augment path/target/child resolution, feature gates and deviations. Check both compiled tree shape and source provenance (`tests/compiler.test.ts`).
4. **Types** — boundaries and canonical values for every built-in type and restriction; enum/bit numbering; union branch selection; exact 64-bit and decimal parsing; derived restrictions and defaults; `invert-match`; XSD regular-expression syntax that JavaScript would misread. Form-level cases live in `tests/forms.test.ts`, `tests/boundaries.test.ts`, `tests/canonical.test.ts`.
5. **XPath** — XPath 1.0 behavior, YANG name resolution (own prefix, imported prefixes), axes/predicates/coercions, node-set comparison, all YANG functions, `current()`, `deref()` for leafref and instance-identifier values, absent nodes, defaults, each accessible-tree context. The differential/fuzz corpus for `qualifyYangXPathNodeTests` is in place (`tests/differential.test.ts`, 2026-11-26): a seeded grammar-generated corpus checks the rewrite is a pure prefix insertion and that unprefixed and explicitly prefixed spellings agree on every accessor, plus a curated corpus of tricky tokens and a mutation-tested operator guard. Current coverage: `tests/xpath.test.ts`, `tests/accessible-tree.test.ts`, `tests/constraints.test.ts`.
6. **Constraints and validation** — `must`, `when`, leafref, instance-identifier, mandatory, choices, keys, unique and cardinality. Test valid/invalid/indeterminate separately and test dependency ordering/cycle reporting for `when`. Include nodes under choices, nested `when` inheritance and absent non-presence containers.
7. **UI-facing API** — candidate enum filtering with complete data context, dynamic re-evaluation when siblings change, unresolved context handling, explanatory reasons; form validation on copied/proxied fields and on fields under lists. Include examples that prevent unsafe static filtering.
8. **Browser integration** — smoke-test ESM exports in a real browser, assert no Node globals or native/WASM/Python requirements, check cancellation and limits, and verify no cross-origin assumptions in the core. Status: in place since 2026-11-26 as `tests/real-browser.test.ts` (Playwright headless Chromium over `examples/standalone.html`), alongside the Node-side source audit and the Node import of `dist`. The suite skip-announces itself when Chromium is not installed on the machine.
   **Static-site integration** — build the Next.js App Router example with the mock server stopped, audit the `out/` tree for server artifacts and the dynamic engine-chunk budget, then serve it in Chromium and verify YANG Library discovery, form validation, PATCH persistence and RPC execution. Repeat under a non-root `basePath`. Gates: `npm run next-static:e2e` and `npm run next-static:e2e:basepath`.
9. **Differential/interoperability** — compare supported compiler and validation cases with libyang in development CI where available. Differences must be triaged against RFC semantics, not blindly copied from the oracle. In-repo part in place since 2026-11-26: the XPath-rewrite fuzz corpus of `tests/differential.test.ts` differentiates `qualifyYangXPathNodeTests` between unprefixed and explicitly prefixed spellings (seeded grammar corpus, pure-prefix-insertion invariant, curated tricky tokens, mutation-tested). libyang itself remains unavailable to the development environment (native C toolchain, no `yanglint`/`pyang` on PATH); if a CI provides it later, wire it in as a dev-only oracle without runtime impact.

## Fixture corpus policy

- Keep `oven.yang` as the quick, readable smoke model.
- Keep RFC 8343/8344 plus the exact imported type modules and IETF interface extension modules as the integration corpus.
- Record origin, revision, license notice and dependency graph in `tests/fixtures/yang/README.md` whenever adding a fixture.
- Add fixtures for uncovered constructs (e.g. cross-module groupings, submodules with their own imports, choices with lists and `must`, typedef-wrapped leafrefs, `unique` over nested paths, `invert-match` patterns, deviations, feature expressions, identity inheritance, leafref predicates, `must`/`when` context) instead of growing one untraceable mega-fixture.
- Do not vendor generated config data as schema input; keep instance data fixtures separate from YANG modules.

## Test tooling gaps

- Tests are type-checked since 2026-11-26: `npm run typecheck` runs `tsc --noEmit` (sources) and `tsc -p tsconfig.tests.json --noEmit` (sources + tests), with the single xmldom→DOM cast centralised in `tests/dom.ts`.
- Node suites run `@xmldom/xmldom`, but `tests/real-browser.test.ts` now exercises the built page in headless Chromium (Playwright, dev-only) with the browser's native DOM; remaining browser-dom differences (for example `parentElement`) surface in that suite rather than being left untested by construction.
- The RESTCONF loader tests use a simulated `fetch`; URL shapes against a real RESTCONF server are unverified.

## Coverage reporting

Maintain a matrix with four states: **implemented**, **partial**, **unsupported**, **untested** (`CONFORMANCE.md`). A parser test only upgrades syntax coverage. A feature is "implemented" only after semantic behavior and negative cases are covered and no known defect is open. A CI failure should include the fixture path, statement location and expected diagnostic where available.

## Release workflow (repeatable)

Every release follows the same gates, in order; a release with any red gate does not ship.

1. `npm run build` — `tsc` must be clean; `dist/index.js` and `dist/index.d.ts` are the only shipped artifacts (the build also regenerates `examples/standalone.html`).
2. `npm test` — the full suite: parser, module-set with budgets/cancellation, compiler, serialization + revision audit + precompile CLI, boundary and canonical corpora, XPath/constraints + differential fuzz, validation, candidates, cross-references, the RFC 7951 adapter and the form-RESTCONF bridge, RESTCONF loader/client/events, public API, documentation, React hooks, worker and optimistic edit, mock RESTCONF server, the Next.js config helper, browser-readiness audit, real browser, bundle smoke. The pretest build keeps those suites against the freshly built `dist`.
3. `npm run next-static:e2e` and `npm run next-static:e2e:basepath` — build the Next.js static export, enforce the server-free output and 256 KiB dynamic engine-chunk budget, then exercise schema discovery, validation, PATCH and RPC in Chromium at `/` and `/yang-console`. The build runs before the mock starts, covering the no-fetch prerender constraint.
4. `npm audit` — zero known vulnerabilities across runtime and development dependencies.
5. Update `CONFORMANCE.md` rows for anything the release changes (a row without its covering test regresses to `untested`; a row with an open defect stays `partial`), and `ROADMAP.md` for stage status.
6. Visual check: serve the repo root over localhost (e.g. `python3 -m http.server`) and open `examples/browser-usage.html` in a current browser; the oven RPC preview must render and validate through `dist/index.js`. This complements the Playwright legs.
7. `npm pack --dry-run` and check the archive: only `dist`, `examples`, docs; no sources, fixtures or tests leak into the tarball. The `prepack` hook builds `dist/` automatically before publishing.

Versioning and diagnostics policy for releases is documented in `CONFORMANCE.md`.
