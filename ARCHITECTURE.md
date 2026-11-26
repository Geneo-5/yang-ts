# Architecture and conformance plan

Status: this document describes the architecture as built on 2026-11-26. Where a section used to say "planned", the code now exists; known defects and open work are tracked in [ROADMAP.md](./ROADMAP.md) and per-row status in [CONFORMANCE.md](./CONFORMANCE.md). Nothing here is a claim of RFC 7950 conformance.

## Audit decision (2026-11-25)

This is a new browser-first TypeScript package, not a wrapper around libyang or a port that assumes a server runtime. `yang-js` remains a useful comparison/reference, but its published package is 0.24.70, last published about two years ago, and its npm metadata still points to RFC 6020; it is not an adequate single source of RFC 7950 behavior. xYang is an independent practical subset and has useful implementation ideas, but does not claim full RFC conformance. Neither is adopted as a runtime dependency.

RFC 7950 uses XPath 1.0 semantics, with YANG-specific namespace resolution, an accessible data tree, context rules and additional functions. Generic browser `document.evaluate()` is unsuitable because YANG instance data is not necessarily a DOM and YANG's unprefixed-name rules differ. The compatibility spike (see [XPATH_SPIKE.md](./XPATH_SPIKE.md)) selected the `xpath` package (0.0.36) as the XPath 1.0 parser/evaluator behind a YANG adapter. It is the package's **only runtime dependency**; the parser, resolver, compiler, validators and function library are implemented in package source.

## Package boundaries (as built)

```text
src/
  index.ts            public entry point (currently `export *` from every module)
  yang/               ast, tokenizer + parser, module-set resolver, semantic compiler / schema IR
  xpath/              XPath adapter, RFC 7950 function library, accessible trees, constraint evaluation
  validation/         data-tree validation (validate-instance), candidate-value evaluation
  forms/              form-model: framework-neutral field metadata and local type validation
  restconf/           RESTCONF path/request builders (paths), YANG Library loader adapter
tests/                one file per layer, plus fixtures/yang (RFC and Sysrepo corpora)
scripts/              build-example.mjs (bundles examples/standalone.html)
```

- `yang/`: source-located statement AST, module dependency resolver with resource budgets, and the compiler that produces the effective schema IR (`CompiledYangSchema`): data/RPC/action/notification trees, groupings/uses/refine, augments, deviations, identities, `if-feature` filtering.
- `xpath/`: `compileYangXPath` (unprefixed-name qualification, `current()`), `createYangFunctionLibrary` (`derived-from*`, `deref`, `re-match`, `enum-value`, `bit-is-set`), `buildAccessibleTree` (RFC 7950 §6.4.1 contexts) and `createConstraintEvaluator` (`must`/`when`).
- `validation/`: `validateDataTree` (keys, unique, mandatory, cardinality, leafref, instance-identifier, `must`/`when`) and `evaluateCandidates` (finite-domain candidate evaluation with reasons).
- `forms/`: `createFormModel`, `validateFormValue`, `canonicalFormOf`.
- `restconf/`: request/path builders (RFC 8040, RFC 8527 NMDA) and an optional YANG Library module loader. Neither is part of the compiler core; nothing in the package sends a request except through a caller-supplied `fetch`.
- Not built as separate packages (earlier plans listed `types/`, `features/`, `constraints/`, `ui/`): type logic lives inside `compiler.ts`, `forms/form-model.ts` and `xpath/yang-functions.ts`; feature evaluation lives inside `compiler.ts`; constraints are in `xpath/` and `validation/`; there is no `ui/` layer beyond `forms/` and `validation/candidates.ts`.

## Planned optional entry points (ROADMAP Stage 8)

Target use: a Next.js site built with `output: 'export'`, running entirely in the browser against a RESTCONF API. None of the following exists yet; the compiler, validators and form model stay framework-neutral and never depend on these entry points.

- `client` (framework-neutral): RFC 7951 JSON ↔ instance-tree bridge and a browser RESTCONF client built on the existing request builders, with injectable `fetch`, auth header callback, `ietf-restconf:errors` mapping, `ETag`/`If-Match` handling and `AbortSignal`. No global access at import time.
- `react` (`"use client"`): headless provider and hooks over the engine; engine initialization in an effect or a `ssr: false` dynamic import; compilation and validation in a Web Worker with a main-thread fallback.
- `next`: a `withYangEngine(nextConfig)` helper or documented snippet for static export (`images.unoptimized`, `basePath`/`assetPrefix`, worker and precompiled-schema assets).
- Build-time precompilation: a serializable, versioned form of `CompiledYangSchema` and a script that writes it to `public/`, with a runtime fallback that discovers modules through the YANG Library loader.

Static export has no server runtime, so the RESTCONF API is cross-origin unless the static files are served from the same origin or behind the same reverse proxy; deployment must provide CORS or same-origin hosting. Prerequisites in the compiler and forms (serializable `FormField` restrictions, validation without mutating the caller's document, curated exports, budgets with worker cancellation) are listed as blockers in `ROADMAP.md`.

## Known architectural debt

- **Two schema stacks.** `createFormModel` walks the parsed statement tree with its own type resolution, while everything else uses `CompiledYangSchema`. The form path ignores `uses`, augments, features, deviations and choice exclusivity, and its `[*]` list paths do not match schema paths. Target: rebuild forms on the compiled schema.
- **Duplicated type/pattern logic.** Pattern compilation (`compilePattern`, `compileXsdPattern`), the builtin type lists and typedef lookup exist in several files. Target: a shared `types/` module (also the right place for XSD-to-JS pattern translation and canonical forms).
- **Identity-keyed side tables.** Form field restrictions live in `WeakMap`s keyed by object identity; copies, clones and reactive proxies of a `FormField` lose them. Target: a serializable restriction descriptor on the field.
- **Module-level caches.** Compiled-XPath and pattern caches are global, keyed without schema identity, and unbounded. Target: schema-scoped `WeakMap` caches.
- **Public surface.** `export *` exposes every helper and makes it semver-locked. Target: curated named exports; internals behind a separate entry point.
- **Raw-document validation.** Validation and candidate evaluation run over the raw instance document instead of the RFC 7950 accessible tree.

## RFC 7950 scope, staged

The intended target is YANG 1.1 (RFC 7950), not a claim of compliance today. Delivered slices: module/submodule grammar, imports/revisions/includes, typedef/grouping/use/augment/refine, data/RPC/action/notification nodes, identities, features, deviations, the builtin types with exact 64-bit and decimal64 arithmetic, XPath 1.0 plus the YANG function library, `must`/`when`, leafref and instance-identifier constraints, canonical values, and effective schemas after features/deviations. Each is partial in the sense recorded in `CONFORMANCE.md`; notable gaps include submodule compilation context, grouping namespace handling across modules, `augment` inside `uses`, deviations on operations, XSD regular-expression semantics, and validation under choices.

Each semantic milestone needs RFC-directed fixtures, explicit unsupported-feature diagnostics and interoperability comparisons; "recognized syntax" must never be reported as "implemented semantics", and an unevaluable check must report `indeterminate`/`pending`, never a pass.

Candidate values are contextual. A finite enumeration can be filtered when constraints can be evaluated over a complete, concrete data context; arbitrary `must` expressions can depend on sibling/ancestor/other-module values, missing nodes, defaults or state data. The API therefore reports `allowed`, `blocked` or `indeterminate` with reasons rather than promising that every possible value set can be statically enumerated.

## Browser and dependency policy

- Runtime: TypeScript/ES2022 ESM, no Node built-ins, filesystem, subprocess, Python or native/WASM wrapper.
- Parsing YANG is implemented in package source to preserve source locations and control grammar behavior.
- The only runtime dependency is `xpath`, audited as browser-safe (`tests/browser-readiness.test.ts`). Test/build tooling is dev-only: TypeScript, Vitest, esbuild and `@xmldom/xmldom`. Any new runtime dependency needs a documented compatibility and bundle audit.
- Keep core independent of fetch, RESTCONF, framework and persistence. The loader interface is async and injected so callers decide how YANG Library resources are obtained.
- Resource limits cover module loading only (module/submodule counts, source size, deadline, abort signal; `maxDepth` is declared but not enforced). Before exposing compilation of untrusted or large server-provided modules in a UI, limits are also needed for grouping expansion, XPath evaluation, regex execution and parser nesting depth, with real cancellation (for example a worker with a timeout). Patterns from server-provided modules are executed as JavaScript regular expressions, so ReDoS is an open risk.

## Quality gates

1. Parser fixtures and negative grammar cases.
2. RFC section-linked unit cases for type restrictions, XPath contexts/functions and constraint timing, each with a negative case.
3. Differential checks: an XPath-rewrite fuzz corpus runs in-repo (`tests/differential.test.ts`, seeded and grammar-generated); checks against libyang remain a development/CI-only option when it becomes available — libyang is not shipped or run in users' browsers, and no `yanglint`/`pyang` toolchain exists in this environment.
4. Browser bundle inspection (done, as a source audit) and tests in a real browser (not yet done: all suites run under Node with `@xmldom/xmldom`) before declaring the package browser-ready.
5. Conformance matrix labels each feature as implemented, partial, unsupported or untested; a known open defect keeps a row at partial.
