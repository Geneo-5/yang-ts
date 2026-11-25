# Test strategy

The goal is to prove behavior by layer and to prevent partial support from looking like full support. Every semantic test should link to an RFC section or an identified real-world fixture and state whether it is positive, negative or intentionally indeterminate.

## Current gates

Run before each commit:

```sh
npm test
npm run build
npm audit --omit=dev
```

The source parser, module resolver and an initial semantic compiler pass are covered. The upstream fixtures prove parsing and retention of imports, augment paths and `if:type`-dependent `when` statements; compiler tests also assert schema trees, use-site typedef/grouping resolution, refine, augment application, feature filtering, identity inheritance and all deviation operation kinds. Full statement validation remains uncovered.

## Test layers to add with the roadmap

1. **Lexer/parser** — every statement form, comments, escaped and concatenated strings, whitespace, malformed delimiters, unterminated strings/comments, and precise line/column diagnostics. Parse the real fixture corpus on every change.
2. **Module set** — imports/includes with pinned and unpinned revisions, submodules, multiple revisions, missing dependencies, duplicate modules, and cycle diagnostics. Assert the exact resolved dependency closure. Implemented partially by `tests/module-set.test.ts`; malformed metadata and richer submodule corpus remain.
3. **Semantic compiler** — statement legality/cardinality, namespaces/prefixes, typedef inheritance, uses/refine, effective list keys, explicit and implicit choice cases, augment path resolution, feature gates and deviations. Check both compiled tree shape and source provenance. Initial tree, grouping, typedef, refine, augment, feature-filter, identity and deviation cases live in `tests/compiler.test.ts`.
4. **Types** — boundaries and canonical values for every built-in type and restriction; enum/bit numbering; union branch selection; exact 64-bit and decimal parsing; derived restrictions and defaults. Inherited open bounds, range/length restrictions and enum/bits subsets have focused form-validation cases in `tests/forms.test.ts`.
5. **XPath** — XPath 1.0 parser/evaluator behavior, YANG name resolution, axes/predicates/coercions, node-set comparison, all YANG functions, `current()`, absent nodes, defaults, and each accessible-tree context. Include RFC examples and focused predicates from `ietf-if-extensions`.
6. **Constraints** — `must`, `when`, leafref, instance-identifier, mandatory, choices, keys, unique and cardinality. Test true/false/indeterminate separately and test dependency ordering/cycle reporting for `when`.
7. **UI-facing API** — candidate enum filtering with complete data context, dynamic re-evaluation when siblings change, unresolved context handling, and explanatory reasons. Include examples that prevent unsafe static filtering.
8. **Browser integration** — smoke-test ESM exports in a real browser, assert no Node globals or native/WASM/Python requirements, check cancellation and limits, and verify no cross-origin assumptions in the core.
9. **Differential/interoperability** — compare supported compiler and validation cases with libyang in development CI where available. Differences must be triaged against RFC semantics, not blindly copied from the oracle.

## Fixture corpus policy

- Keep `oven.yang` as the quick, readable smoke model.
- Keep RFC 8343/8344 plus the exact imported type modules and IETF interface extension modules as the integration corpus.
- Record origin, revision, license notice and dependency graph in `tests/fixtures/yang/README.md` whenever adding a fixture.
- Add fixtures for uncovered constructs (e.g. deviations, feature expressions, identity inheritance, typedef/grouping reuse, leafref predicates, `must`/`when` context) instead of growing one untraceable mega-fixture.
- Do not vendor generated config data as schema input; keep instance data fixtures separate from YANG modules.

## Coverage reporting

Maintain a matrix with four states: **implemented**, **partial**, **unsupported**, **untested**. A parser test only upgrades syntax coverage. A feature is “implemented” only after semantic behavior and negative cases are covered. A CI failure should include the fixture path, statement location and expected diagnostic where available.
