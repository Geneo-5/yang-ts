# yang-browser-engine

Browser-first TypeScript foundation for compiling YANG 1.1 schemas and exposing them to user interfaces. The project is at its parser foundation stage; it is not yet a complete YANG compiler or validator.

```ts
import { parseYang } from "yang-browser-engine";

const module = parseYang(`module demo { yang-version 1.1; namespace "urn:demo"; prefix d; }`);
console.log(module.argument); // demo
```

The package parses the generic YANG statement grammar into a source-located AST, resolves module import/include closures through an injected async loader, and has an **initial semantic compiler** for source-linked data schema trees, groupings, typedef names, and augments. It also includes a **partial form helper** for data and RPC input/output field metadata and safe, local type checks. It is not a full YANG compiler or validator: complete RFC 7950 semantics, XPath evaluation and contextual `must`/`when` validation remain in progress. See [ARCHITECTURE.md](./ARCHITECTURE.md) for scope and design, [ROADMAP.md](./ROADMAP.md) for milestones, and [TESTING.md](./TESTING.md) for validation gates and coverage policy.

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

The helper currently extracts descriptions, units, defaults, required/read-only flags, enums, bits, simple types and cardinality. It resolves local typedefs; pass imported modules in `createFormModel(module, { modules })` to resolve imported typedefs. Type/range/length checks are performed locally. Pattern, leafref, identityref, binary and unresolved types are marked indeterminate; `must`, `when` and `if-feature` expressions are returned as pending with their YANG `error-message` when available. This avoids presenting partial checks as full model validation.

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

## Browser example

After building, serve the repository root over HTTP and open [`examples/browser-usage.html`](./examples/browser-usage.html). It parses the Sysrepo oven model in the browser, populates the `insert-food` timing enum, validates the selected value, and previews the corresponding RESTCONF RPC request. The example does not send the request, resolve typedefs, apply augments, or evaluate `must`/`when` constraints.

## Development

Requires Node.js 20+ for development tooling. The published runtime is ESM targeting ES2022 and uses no Node APIs.

```sh
npm install
npm test
npm run build
```
