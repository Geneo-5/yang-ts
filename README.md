# yang-browser-engine

Browser-first TypeScript foundation for compiling YANG 1.1 schemas and exposing them to user interfaces. The engine parses YANG, resolves module sets, compiles an effective schema, evaluates `must`/`when` constraints and validates instance data, but it is not a complete or conformance-tested YANG implementation: see [Status](#status).

```ts
import { parseYang } from "yang-browser-engine";

const module = parseYang(`module demo { yang-version 1.1; namespace "urn:demo"; prefix d; }`);
console.log(module.argument); // demo
```

The package parses the generic YANG statement grammar into a source-located AST, resolves module import/include closures through an injected async loader, and has an **initial semantic compiler** for source-linked schema trees, use-site grouping expansion with refinements, augments, deviations, identities and optional `if-feature` filtering. It also includes a **partial form helper** for data and RPC input/output field metadata and safe, local type checks. The package evaluates compiled `must`/`when` expressions over RFC 7950 accessible trees (XPath 1.0 through the `xpath` package) and validates instance data and finite-domain candidate values with valid/invalid/indeterminate results. These layers are partial: complete RFC 7950 semantics are not implemented, and a source review (2026-11-26) found open defects that are listed in [ROADMAP.md](./ROADMAP.md). See [ARCHITECTURE.md](./ARCHITECTURE.md) for scope and design, [ROADMAP.md](./ROADMAP.md) for milestones, and [TESTING.md](./TESTING.md) for validation gates and coverage policy.

## Module dependencies

```ts
import { parseYang, resolveModuleSet } from "yang-browser-engine";

const root = parseYang(rootYangText);
const moduleSet = await resolveModuleSet([root], {
  async loadModule(name, revision) {
    // Return YANG source text, parsed modules, candidate revisions, or undefined.
    return moduleStore.get(name, revision);
  },
  async loadSubmodule(name, revision) {
    return submoduleStore.get(name, revision);
  },
});
moduleSet.modules;      // Stable module closure, sorted by name and revision
moduleSet.submodules;   // Included submodules
moduleSet.diagnostics;  // Missing, ambiguous, cyclic, or malformed dependencies
```

The loader is transport-neutral, so browser applications can supply bundled modules, IndexedDB, or their own fetch/YANG Library integration. Unpinned imports select the newest available revision; pinned `revision-date` imports require that exact revision.

For a feature-specific effective tree, pass enabled feature identities to `compileYangModules`:

```ts
import { compileYangModules } from "yang-browser-engine";

const schema = compileYangModules(moduleSet, {
  enabledFeatures: new Set(["ietf-interfaces:if-mib", "ietf-if-extensions:loopback"]),
});
```

Feature-expression evaluation supports `not`, `and`, `or`, parentheses, and imported prefixes. Omitting `enabledFeatures` retains all feature-gated nodes and records their requirements in the IR.

## Form helper

```ts
import { createFormModel, parseYang, validateFormValue } from "yang-browser-engine";

const module = parseYang(ovenYangSource);
const form = createFormModel(module);
const timing = form.fields.find(field => field.path === "/insert-food/input/time")!;

timing.options; // [{ value: "now", label: "now", description: "..." }, ...]
timing.help;    // YANG description, when present

const result = validateFormValue(timing, "now");
// result.status: "valid" | "invalid" | "indeterminate"
// result.errors: displayable local validation errors
// result.pending: must/when/if-feature or unsupported checks not evaluated
```

The helper currently extracts descriptions, units, defaults, required/read-only flags, enums, bits, simple types and cardinality. It resolves local typedefs; pass imported modules in `createFormModel(module, { modules })` to resolve imported typedefs. Type/range/length checks are performed locally. Patterns outside the supported XML Schema/JavaScript subset, leafref/identityref values checked without a `FormCrossReference` context, and unresolved types are marked indeterminate; `must`, `when` and `if-feature` expressions are returned as pending with their YANG `error-message` when available. This avoids presenting partial checks as full model validation. The form model is built from the parsed module only: it ignores `uses`, augments, features, deviations and choice exclusivity. Range, length, pattern, fraction-digits, identityref-base and bits restrictions travel on a serializable descriptor carried by the field, so copies, clones and reactive proxies keep validating.

## RPC and RESTCONF helpers

`createFormModel` exposes RPCs in `form.operations`, with separate `inputFields` and `outputFields`. Helpers prepare RESTCONF paths and JSON envelopes; they never perform network requests:

```ts
import { createRestconfRpcRequest, nodeToRestconfDataPath } from "yang-browser-engine";

const insertFood = form.operations.find(operation => operation.name === "insert-food")!;
const request = createRestconfRpcRequest(insertFood, { time: "now" });
// POST /restconf/operations/oven:insert-food
// { "oven:input": { "time": "now" } }

const uri = nodeToRestconfDataPath([
  { module: "ietf-interfaces", name: "interfaces" },
  { module: "ietf-interfaces", name: "interface", keys: [{ name: "name", value: "eth0" }] },
]);
// /restconf/data/ietf-interfaces:interfaces/interface=eth0

const target = [
  { module: "ietf-interfaces", name: "interfaces" },
  { module: "ietf-interfaces", name: "interface", keys: [{ name: "name", value: "eth0" }] },
];
const get = createRestconfGetRequest(target);
const set = createRestconfSetRequest(target, {
  module: "ietf-interfaces", name: "interface", data: { name: "eth0", enabled: true },
});
const update = createRestconfUpdateRequest(target, {
  module: "ietf-interfaces", name: "interface", data: { enabled: false },
});
const remove = createRestconfDeleteRequest(target);
const filtered = createRestconfGetRequest([], "/restconf", {
  content: "config", depth: 2, fields: "ietf-interfaces:interfaces/interface(name,enabled)",
  filter: "/ietf-interfaces:interfaces/interface[enabled='true']",
});
```

`nodeToXPath(contextModule, path)` is a separate helper for YANG XPath expressions and uses prefixes declared by the context module. RESTCONF data resource paths follow RFC 8040 URI rules; they are not XPath strings. The current helpers build paths from caller-supplied schema path segments and do not yet compile a schema or verify that nodes and list keys exist.

For collection/resource operations, `createRestconfGetRequest` prepares GET, `createRestconfAddRequest(parent, resource)` prepares POST creation under a parent, `createRestconfSetRequest` prepares PUT replacement, `createRestconfUpdateRequest` prepares plain PATCH merge, and `createRestconfDeleteRequest` prepares DELETE. `readRestconfData(response, module, name)` unwraps a JSON response node. In RESTCONF, POST creates a child resource; PATCH performs a partial merge update. There is no general POST update operation. These methods and JSON envelopes follow [RFC 8040 §§4.4–4.7](https://datatracker.ietf.org/doc/html/rfc8040#section-4).

Every RESTCONF request builder accepts an optional `RestconfQueryParameters` record after the RESTCONF root argument. Values are URL-encoded; standard parameters such as `content`, `depth`, `fields`, and `filter` can be passed along with server extensions. The helper leaves method/parameter compatibility to the caller and server (for example, `insert` and `point` apply to ordered-by-user list or leaf-list edits).

RFC 8527 NMDA datastore resources are available through `nodeToRestconfDatastorePath` and `createRestconfDatastoreRequest`. Use the namespace-qualified identities `ietf-datastores:operational`, `ietf-datastores:running`, and `ietf-datastores:intended`; custom datastore identities can also be passed module-qualified. `createRestconfNmdaProbeRequest()` prepares a `HEAD /restconf/ds/ietf-datastores:operational` capability probe. On operational datastore GETs, `{ "with-origin": true }` emits the presence-only `?with-origin` flag; `false` omits it. The helper exposes datastore requests and does not discover server capabilities or enforce whether a datastore is writable. NMDA server support is advertised through the operational datastore resource and YANG Library as specified by [RFC 8527](https://datatracker.ietf.org/doc/html/rfc8527).

## Precompiling schemas

Compilation is the expensive step; `yang-browser-engine precompile` does it at build time so the browser only loads the result:

```sh
npx yang-browser-engine precompile src/yang/*.yang --features my-module:my-feature --out public
```

It writes `public/yang-schema.json` (the versioned serialized schema), verbatim copies under `public/yang-modules/`, and `public/yang-manifest.json` (module name/revision/namespace/file inventory). In the browser, load and revive the bundle without the parser or compiler:

```ts
import { deserializeCompiledSchema } from "yang-browser-engine";
const payload = JSON.parse(await (await fetch("yang-schema.json")).text());
const schema = deserializeCompiledSchema(payload); // → CompiledYangSchema
```

`deserializeCompiledSchema` throws `CompiledSchemaFormatError` with a `code` (`format`, `version`, `structure`) when the artifact is stale or corrupt — recompile with the matching release. Parse errors, module-set diagnostics and compile diagnostics make the CLI exit 2 and write nothing.

## Browser example

After building, serve the repository root over HTTP and open [`examples/browser-usage.html`](./examples/browser-usage.html). It parses the Sysrepo oven model in the browser, populates the `insert-food` timing enum, validates the selected value, and previews the corresponding RESTCONF RPC request. The example does not send the request, resolve typedefs, apply augments, or evaluate `must`/`when` constraints.

## Status

This is a pre-1.0 engine, not a conformance-tested YANG implementation. Where an area is only partly implemented, the engine reports `indeterminate`/`pending` instead of a pass; the correctness review of 2026-11-26 closed the review findings (leafrefs through typedefs, `choice`/`case` validation, `unique` semantics, identityref XML prefixes, partial-pattern handling — see `CONFORMANCE.md`).

- [CONFORMANCE.md](./CONFORMANCE.md) records the status of each RFC area and its known gaps; it is the authority on what is implemented.
- [ROADMAP.md](./ROADMAP.md) lists the open defects by stage and the priority order for fixing them.
- `capabilities` in the bundle reports possession of a feature layer, not conformance; `validation` is `partial` (see `CONFORMANCE.md` for the exact rows).
- The optional YANG Library loader (`createRestconfModuleLoader`) has open issues with URL shape and submodule lists; see the roadmap before relying on it against a real server.
- Resource budgets cover module loading only; treat compilation and validation of untrusted modules as unbounded in time and memory.

## Development

Requires Node.js 20+ for development tooling. `npm test` is self-sufficient — a `pretest` hook builds `dist/` first (the real-browser suite additionally needs `npx playwright install chromium`, installed as a dev-time action; without it the suite announces its own skip). The published runtime is ESM targeting ES2022 and uses no Node APIs.

```sh
npm install
npm test        # builds first via pretest
npm run build   # dist + examples/standalone.html
npm run typecheck
```
