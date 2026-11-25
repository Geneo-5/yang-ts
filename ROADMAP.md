# Roadmap

This roadmap targets an RFC 7950 YANG 1.1 engine that runs entirely in browsers. It is intentionally incremental: a later stage starts only when its predecessor has usable diagnostics and regression fixtures.

**Status as of 2026-11-26 (after a full source review).** Stages 0–6 delivered their intended feature slices, but the review found defects that make several of them *partial* rather than *complete*. Earlier revisions of this file declared every stage complete; that overstated the state. Status labels now follow `CONFORMANCE.md`:

- **done** — regression-tested, no known defect.
- **done, defects open** — the feature slice exists and is tested, but known bugs are listed under the stage and tracked in Stage 7.
- **partial** — a defined slice works; named gaps remain.

A stage returns to **done** only when every defect listed under it is closed by a test that failed before the fix. Items marked `[x]` are closed with a red-then-green regression (`tests/stage7-p0.test.ts`, 2026-11-26); remaining `[ ]` findings still need a failing test first. The Stage 7 **P0 batch is closed**; P1 is next.

## Stage 0 — Parser foundation (done, defects open)

- Parse the YANG statement grammar into a source-located AST; preserve adjacent quoted-string concatenation.
- Fixtures: Sysrepo `oven.yang`; RFC 8343 interfaces, RFC 8344 IP augment and import closure; IETF interface extension drafts with `when` over `if:type`.

Open defects:
- [ ] A quoted string whose value is exactly `;` or `{` terminates the argument/statement (the parser compares token values, not `kind`), so `default ";";` fails to parse.
- [ ] Double-quoted escapes: the backslash is dropped, so `\n` and `\t` become `n` and `t` (RFC 7950 §6.1.3). Unknown escapes should be errors.
- [ ] Multi-line double-quoted strings keep file indentation and trailing whitespace; RFC 7950 §6.1.3 requires stripping both. This pollutes form `help` text.
- [ ] An empty-string argument (`default "";`) is dropped and is indistinguishable from "no argument"; several arguments without `+` are silently joined instead of rejected.
- [ ] Error locations: EOF errors report line 1 / the keyword instead of the end of input. No maximum nesting depth (recursive descent).

## Stage 1 — Module set and dependency resolution (done, defects open)

- Injected async loader, import/include/belongs-to closure, revision selection, missing/ambiguous/cyclic diagnostics, stable ordering.
- `ModuleSetConstraints`: abort signal, module/submodule counts, source characters, wall-clock deadline.

Open defects:
- [x] `ModuleSetBudget.maxDepth` is enforced on import and include chains since 2026-11-26 (single `budget-exceeded` diagnostic, refusing mode), regression-tested in `tests/stage7-p0.test.ts`.
- [ ] Deadline and abort are only checked before each load; synchronous parsing of a large document cannot be interrupted.
- [ ] Several revisions of one module can end up in the set and then compile as duplicate roots.

## Stage 2 — Semantic compiler and effective schema (partial)

Delivered: source-linked schema IR, grouping expansion with `refine`, choices/cases (explicit and shorthand), augments (data, RPC/action input/output, notification), deviations (`not-supported`, `add`, `replace`, `delete`), identities with cycle checks, `if-feature` filtering, nested actions, cardinality and type-restriction legality checks.

Open defects:
- [x] Nested nodes of a grouping defined in another module now inherit the instantiating module/namespace (`instantiatingModule` and inherited `when`/`if-feature` are forwarded to every expansion level), regression-tested in `tests/stage7-p0.test.ts` (2026-11-26).
- [x] Submodule context: data nodes, operations, augment and deviation statements of a submodule now resolve their `type`, `uses` and augment paths in the submodule's own document (its imports and its `belongs-to` prefix), keeping the parent module's namespace for schema identity; XPath prefix maps (`moduleNamespacePrefixes`) include the included submodules' imports and `belongs-to` prefixes (2026-11-26, `tests/stage7-p1.test.ts`).
- [ ] `refine` of a `leaf` rejects `mandatory` (allowed by RFC 7950 §7.13.2); `augment` inside `uses` is ignored.
- [ ] Typedef and grouping lookup ignores scoping rules (§6.2.1) and walks the whole module per reference (O(N²)); needs a per-module index.
- [ ] `when` inherited through several levels is always evaluated at the immediate parent element.
- [ ] Not handled: `if-feature` on `enum`/`bit`, feature-to-feature dependencies, deviations targeting RPC/action/notification nodes, name uniqueness across choice cases.

## Stage 3 — Type system and canonical values (partial)

Delivered: integer boundaries including exact 64-bit BigInt, decimal64 scaled arithmetic, string length/pattern, binary base64, enum/bits with derived restrictions, union in declaration order, canonical forms, leafref/identityref form-level checks, boundary corpus.

Open defects:
- [x] `pattern` with `modifier invert-match` inverts only its own pattern in the conjunction (fixed 2026-11-26, `tests/stage7-p0.test.ts`).
- [x] Patterns outside the proven-safe XSD/JS subset stay `pending` (fixed 2026-11-26): divergent escapes (`\d \D \w \W \s \S \p \P \i \c`), backreferences, `(?` groups, class subtraction, `[]` forms and out-of-class `^`/`$` never compile; shared logic lives in `src/types/xsd-pattern.ts` (test: `tests/stage7-p0.test.ts`).
- [ ] Unparsable `range`/`length` endpoints are treated as unbounded (constraint silently satisfied).
- [ ] Type and builtin-name logic is still duplicated (three builtin lists); extract a shared `types/` module. The pattern compiler is now shared (`src/types/xsd-pattern.ts`, first `types/` module).
- [ ] Canonical forms for identityref and instance-identifier are not represented.

## Stage 4 — XPath 1.0 and YANG evaluation context (partial)

Delivered: `xpath@0.0.36` adapter with unprefixed-name qualification, `current()`, the RFC 7950 function library, accessible trees (§6.4.1) and `must`/`when` evaluation.

Open defects:
- [x] The module's own `prefix` is in the prefix→namespace maps of must/when compilation, the leafref resolver and the identity library (`moduleNamespacePrefixes`, fixed 2026-11-26, `tests/stage7-p0.test.ts`).
- [ ] Identityref values are resolved as `module-name:identity`; XML instances use arbitrary prefixes bound by namespace, so `ianaift:ethernetCsmacd` does not match.
- [ ] `enum-value` uses a schema-wide name→value table and throws on ambiguous names instead of resolving the argument node's own type.
- [ ] `buildAccessibleTree`: the datastore context node is now the datastore document with the data root as document element (RFC 6.4.1, fixed 2026-11-26), so absolute YANG paths resolve; still open: only a single root element is accepted, and defaults of inactive cases are injected.
- [ ] Module-level compiled-expression caches are keyed without schema identity and grow without bound.
- [ ] `qualifyYangXPathNodeTests` is a heuristic token scanner; it needs a differential/fuzz corpus against the evaluator's own parser.
- [ ] `instance-identifier` `deref` and metadata annotations remain unsupported (see `CONFORMANCE.md`).

## Stage 5 — Validation and conditional UI introspection (partial)

Delivered: `validateDataTree` (keys, unique, mandatory, cardinality, leafref, instance-identifier, `must`/`when`), form-level validation, `evaluateCandidates` with per-constraint reasons.

Open defects (several return *valid* where the result is unknown — highest priority):
- [x] Leafrefs declared through a typedef are checked: the resolver (and form-level cross-reference) reads the effective `path` from the own `type` or any `leafref` layer of the `typedefChain` (`leafrefPathStatementOf`, fixed 2026-11-26, `tests/stage7-p0.test.ts`).
- [x] `visitElement` descends into `choice`/`case`: members get full constraint/cardinality evaluation, and a mandatory leaf of the active case is enforced while inactive cases impose nothing (fixed 2026-11-26, `tests/stage7-p0.test.ts`).
- [x] `unique` resolves each sub-path into (namespace, name) steps from the declaring module's prefix map, traverses direct children only, excludes entries missing a referenced leaf (§7.8.3) and checks every `unique` statement separately (fixed 2026-11-26, `tests/stage7-p0.test.ts`).
- [x] Validation evaluates the accessible tree, not the raw document (fixed 2026-11-26, `tests/stage7-p1.test.ts`): every matching root is validated through its own `buildAccessibleTree` datastore document — declared defaults are injected (`§7.6.1`), so `must` and leafref resolution see with-defaults content, and `includeState: false` hides `config false` subtrees instead of failing their mandatory nodes; the when-probe now mutates the internal accessible copy, never the caller's document.
- [ ] Mandatory descendants of absent non-presence containers are not enforced.
- [ ] `FormField` validation depends on a `WeakMap` keyed by object identity: copies, clones and reactive proxies silently lose range/length/pattern/fraction-digits. Replace with a serializable restriction descriptor.
- [ ] Form paths carry `[*]` for lists while `findSchemaNodeByPath` does not strip it, so leafref cross-reference checks under lists always stay `pending`.
- [ ] Leaf-lists of leafref/identityref with a cross-reference context always report an error (the array is treated as a scalar); union leaf-lists are always `indeterminate`.
- [ ] `createFormModel` is a parallel, parse-tree-based path that ignores `uses`, augments, features, deviations and choice exclusivity (mandatory leaves in a case are marked `required` regardless of the active case). Rebuild it on `CompiledYangSchema`.
- [ ] `evaluateCandidates`: location uses `node.path` (which contains choice/case segments) and the leaf's namespace for every ancestor, so augmented nodes and nodes under choices are never found; no way to target a specific list entry; the caller's document is mutated without `try/finally`; only constraints declared on the node itself are considered, not sibling constraints that depend on it.

## Stage 6 — Browser release readiness (partial)

Delivered: browser-readiness source audit, conformance matrix and versioning policy, YANG Library/RESTCONF loading adapter, resource budgets for loading, release workflow, standalone example build.

Open defects:
- [ ] Tests run under Node with `@xmldom/xmldom`; there is no real-browser run (Vitest browser mode or Playwright). The "browser smoke suite" is only a Node import of `dist`.
- [ ] `npm test` fails on a clean checkout (bundle-smoke requires `dist/`), while README and `TESTING.md` order `npm test` before `npm run build`.
- [ ] Tests are not type-checked (`tsconfig` includes only `src`).
- [ ] RESTCONF loader: the default library URL omits `/data/` (RFC 8040); submodules are looked up as top-level module rows instead of the nested `submodule` lists of RFC 7895/8525; RFC 7895 `schema` is ignored (only `location`); no `AbortSignal` option.
- [ ] Public surface: `export *` makes every helper semver-locked; `capabilities` still reports `xpath: "planned"` and `moduleResolution: "planned"`.
- [ ] Documentation drift: README ("parser foundation stage"), `ARCHITECTURE.md` ("zero dependencies", planned `types/`, `features/`, `ui/` layout that does not exist) and `CONFORMANCE.md` (e.g. resource budgets "implemented" while `maxDepth` is unenforced) disagree with the code and with each other.

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
- [ ] Submodule compilation context (Stage 2).
- [ ] Validate on the accessible tree (defaults, config/state) (Stage 5).
- [ ] `FormField` restriction descriptor; `[*]` path mismatch; leaf-list cross-references (Stage 5).
- [ ] `evaluateCandidates` location, entry targeting and non-mutation (Stage 5).
- [ ] `refine` `mandatory`; `augment` under `uses`; typedef/grouping scoping and index (Stage 2).
- [ ] RESTCONF loader paths and submodule lists (Stage 6).
- [ ] Namespace-aware identityref resolution for XML; `enum-value` by node type (Stage 4).
- [ ] Accessible tree: wrapper documents, inactive-case defaults (Stage 4).

**P2 — hardening for untrusted modules**
- [ ] Budgets beyond loading: grouping/`uses` expansion node count, XPath evaluation steps/time, regex execution (ReDoS), parser nesting depth, CPU cancellation (worker + timeout).
- [ ] Schema-scoped caches (`WeakMap<schema, …>`) instead of module-level maps.
- [ ] Differential testing against libyang (development only) and an XPath-rewrite fuzz corpus.

**P3 — project hygiene**
- [ ] Align `capabilities`, README, `ARCHITECTURE.md`, `CONFORMANCE.md` and this file; make `CONFORMANCE.md` rows downgrade to *partial* until their stage defects close.
- [ ] Curate `src/index.ts` into named exports; move helpers to an internal entry point.
- [ ] Real-browser test run; type-check tests; make `npm test` self-sufficient (build `dist` in a `pretest` or skip the bundle suite with a clear message); add `prepack` to build before publishing.
- [ ] Extract shared `types/` code and remove the duplicated pattern/builtin logic.

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
- [ ] Serializable `FormField` restriction descriptor (P1): React state, props and proxies copy objects, and the current `WeakMap` silently drops restrictions.
- [ ] Validation and candidate evaluation on the accessible tree without mutating the caller's document (P0/P1).
- [ ] Leafref via typedef, validation under `choice`/`case`, `unique`, own-prefix XPath, cross-module groupings (P0).
- [ ] RESTCONF loader fixes: `/data/` URL shape, nested submodule lists, RFC 7895 `schema`, `AbortSignal` (P1).
- [ ] Curated named exports and `sideEffects`-safe entry points (P3), so the Next.js bundle only contains what the page imports.
- [ ] Budgets and worker-based cancellation for untrusted modules from a device (P2).

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
