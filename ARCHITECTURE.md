# Architecture and conformance plan

Status: this document describes the architecture as built on 2026-11-26. Where a section used to say "planned", the code now exists; known defects and open work are tracked in [ROADMAP.md](./ROADMAP.md) and per-row status in [CONFORMANCE.md](./CONFORMANCE.md). Nothing here is a claim of RFC 7950 conformance.

## Audit decision (2026-11-25)

This is a new browser-first TypeScript package, not a wrapper around libyang or a port that assumes a server runtime. `yang-js` remains a useful comparison/reference, but its published package is 0.24.70, last published about two years ago, and its npm metadata still points to RFC 6020; it is not an adequate single source of RFC 7950 behavior. xYang is an independent practical subset and has useful implementation ideas, but does not claim full RFC conformance. Neither is adopted as a runtime dependency.

RFC 7950 uses XPath 1.0 semantics, with YANG-specific namespace resolution, an accessible data tree, context rules and additional functions. Generic browser `document.evaluate()` is unsuitable because YANG instance data is not necessarily a DOM and YANG's unprefixed-name rules differ. The compatibility spike (see [XPATH_SPIKE.md](./XPATH_SPIKE.md)) selected the `xpath` package (0.0.36) as the XPath 1.0 parser/evaluator behind a YANG adapter. It is the package's **only runtime dependency**; the parser, resolver, compiler, validators and function library are implemented in package source.

## Package boundaries (as built)

```text
src/
  index.ts            curated public barrel; src/internal.ts holds the internal helpers
  bin/                precompile CLI (Node, build-time tool)
  yang/               ast, tokenizer + parser, module-set resolver, semantic compiler / schema IR
  types/              built-in type registry, shared XSD pattern translation
  xpath/              XPath adapter, RFC 7950 function library, accessible trees, constraint evaluation
  validation/         data-tree validation (validate-instance), candidate-value evaluation
  forms/              form model on the compiled schema, binding helpers, RESTCONF body bridge
  restconf/           request/path builders, YANG Library loader, revision audit, RFC 7951 adapter, client
  react/              optional entry point: provider/hooks, worker protocol + runner
tests/                one file per layer, plus fixtures/yang (RFC and Sysrepo corpora)
scripts/              build-example.mjs (bundles examples/standalone.html)
```

- `yang/`: source-located statement AST, module dependency resolver with resource budgets, and the compiler that produces the effective schema IR (`CompiledYangSchema`): data/RPC/action/notification trees, groupings/uses/refine, augments, deviations, identities, `if-feature` filtering.
- `xpath/`: `compileYangXPath` (unprefixed-name qualification, `current()`), `createYangFunctionLibrary` (`derived-from*`, `deref`, `re-match`, `enum-value`, `bit-is-set`), `buildAccessibleTree` (RFC 7950 §6.4.1 contexts) and `createConstraintEvaluator` (`must`/`when`). Only `buildAccessibleTree` and `createConstraintEvaluator` are on the public barrel (`src/index.ts`); compile/rewrite helpers are reachable via `src/internal.ts`.
- `validation/`: `validateDataTree` (keys, unique, mandatory, cardinality, leafref, instance-identifier, `must`/`when`) and `evaluateCandidates` (finite-domain candidate evaluation with reasons).
- `forms/`: `createFormModel`, `validateFormValue`, `canonicalFormOf`.
- `restconf/`: request/path builders (RFC 8040, RFC 8527 NMDA) and an optional YANG Library module loader. Neither is part of the compiler core; nothing in the package sends a request except through a caller-supplied `fetch`.
- `types/`: `builtins.ts` (single-sourced RFC 7950 §9 built-in registry and restriction compatibility) and `xsd-pattern.ts` (shared pattern translation and the untrusted-pattern guards). Feature evaluation stays in `compiler.ts`; constraints are in `xpath/` and `validation/`; there is no `ui/` layer beyond `forms/` and `validation/candidates.ts`.

## Optional entry points (ROADMAP Stage 8)

Target use: a Next.js site built with `output: 'export'`, running entirely in the browser against a RESTCONF API. The compiler, validators and form model stay framework-neutral and never depend on these entry points.

Delivered (2026-11-26, tests cited in `CONFORMANCE.md`):

- `restconf/`: the RFC 7951 JSON ↔ instance-tree adapter, the YANG Library module loader with the revision-mismatch audit, and `createRestconfClient` executed through an injected `fetch` (typed errors, `ETag`/`If-Match`, opt-in idempotent retry, timeouts), plus RFC 8040 §6 notification streams.
- `forms/`: RESTCONF body helpers (`formValuesToRestconfBody`, `formInputToRestconfBody`, `formPathToYangPathSegments`) and the case-selection/list-entry binding API.
- Bin: `yang-browser-engine precompile` writes the versioned serialized schema, verbatim module texts and a manifest for build-time precompilation.
- `react/`: `YangProvider`/`useYangSchema` and headless hooks (`useFormModel`, `useFieldValidation`, `useDataValidation`, `useCandidates`, `useRestconfResource`), plus worker delegation (`createYangRunner`, `spawnYangWorker`) with a main-thread fallback. React stays an optional peer dependency; the core barrel remains React-free.
- Stage 8.6 delivered: `examples/next-static/` statically exports the YANG console, with a mock server, Playwright E2E in Chromium, a 256 KiB dynamic engine-chunk budget, and a repeat of the full browser flow under `/yang-console`. The commands and evidence are listed in `TESTING.md` and `ROADMAP.md`.

Static export has no server runtime, so the RESTCONF API is cross-origin unless the static files are served from the same origin or behind the same reverse proxy; deployment must provide CORS or same-origin hosting. The compiler/form prerequisites (serializable `FormField` restrictions, validation without mutating the caller's document, curated exports, budgets with worker cancellation) and Stage 8.4–8.6 closed on 2026-11-26.

## Known architectural debt

None as of 2026-11-26: the two former items are closed. The form model is rebuilt on `CompiledYangSchema` (the `YangModule` entry compiles on the fly as a compatibility path), and unparsable `range`/`length` endpoints fail closed with `invalid-type-restriction` at compile time. Also closed in the 2026-11-26 review: form restrictions are a serializable field descriptor (no identity-keyed side tables), compiled-XPath caches are schema-scoped and the pattern text cache is bounded, the public barrel is curated (`src/index.ts` vs `src/internal.ts`), and validation/candidate evaluation run on the accessible tree; type logic is single-sourced under `types/`, with the XPath-rewrite differential fuzz corpus in `tests/differential.test.ts`. Remaining engine limitations are listed in `ROADMAP.md` and `CONFORMANCE.md`; Stage 8 integration is delivered.

## RFC 7950 scope, staged

The intended target is YANG 1.1 (RFC 7950), not a claim of compliance today. Delivered slices: module/submodule grammar, imports/revisions/includes, typedef/grouping/use/augment/refine, data/RPC/action/notification nodes, identities, features, deviations, the builtin types with exact 64-bit and decimal64 arithmetic, XPath 1.0 plus the YANG function library, `must`/`when`, leafref and instance-identifier constraints, canonical values, and effective schemas after features/deviations. Each is partial in the sense recorded in `CONFORMANCE.md`; open gaps include metadata annotations, full XML Schema regular-expression semantics, interruption of a synchronous module parse/XPath evaluation, positional instance-identifier list predicates and complete-key/unique-node enforcement, and schema-mount behavior.

Each semantic milestone needs RFC-directed fixtures, explicit unsupported-feature diagnostics and interoperability comparisons; "recognized syntax" must never be reported as "implemented semantics", and an unevaluable check must report `indeterminate`/`pending`, never a pass.

Candidate values are contextual. A finite enumeration can be filtered when constraints can be evaluated over a complete, concrete data context; arbitrary `must` expressions can depend on sibling/ancestor/other-module values, missing nodes, defaults or state data. The API therefore reports `allowed`, `blocked` or `indeterminate` with reasons rather than promising that every possible value set can be statically enumerated.

## Browser and dependency policy

- Runtime: TypeScript/ES2022 ESM, no Node built-ins, filesystem, subprocess, Python or native/WASM wrapper.
- Parsing YANG is implemented in package source to preserve source locations and control grammar behavior.
- The only runtime dependency is `xpath`, audited as browser-safe (`tests/browser-readiness.test.ts`). Test/build tooling is dev-only: TypeScript, Vitest, esbuild and `@xmldom/xmldom`. Any new runtime dependency needs a documented compatibility and bundle audit.
- Keep core independent of fetch, RESTCONF, framework and persistence. The loader interface is async and injected so callers decide how YANG Library resources are obtained.
- Resource limits: module loading budgets (module/submodule counts, source size, deadline, enforced `maxDepth`), a schema-node expansion budget for `uses`/grouping fan-out, pending-pattern guards against oversized or ReDoS-shaped regexes, a parser nesting-depth cap of 200, and cooperative `AbortSignal` cancellation (`deadlineMs` included) in `resolveModuleSet`, `validateDataTree` and `evaluateCandidates`. Compiled XPath expressions live in a schema-scoped `WeakMap`; the pattern text cache is bounded. A single XPath expression cannot be interrupted mid-evaluation (synchronous third-party evaluator): long-running stores need worker isolation, which `createYangRunner` provides with a main-thread fallback.

## Quality gates

1. Parser fixtures and negative grammar cases.
2. RFC section-linked unit cases for type restrictions, XPath contexts/functions and constraint timing, each with a negative case.
3. Differential checks: an XPath-rewrite fuzz corpus runs in-repo (`tests/differential.test.ts`, seeded and grammar-generated); checks against libyang remain a development/CI-only option when it becomes available — libyang is not shipped or run in users' browsers, and no `yanglint`/`pyang` toolchain exists in this environment.
4. Browser bundle inspection (done, as a source audit) and tests in a real browser (`tests/real-browser.test.ts`, Playwright headless Chromium, dev-only; skip-announced when Chromium is absent).
5. Conformance matrix labels each feature as implemented, partial, unsupported or untested; a known open defect keeps a row at partial.
