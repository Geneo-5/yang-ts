# yang-browser-engine

Browser-first TypeScript foundation for compiling YANG 1.1 schemas and exposing them to user interfaces. The project is at its parser foundation stage; it is not yet a complete YANG compiler or validator.

```ts
import { parseYang } from "yang-browser-engine";

const module = parseYang(`module demo { yang-version 1.1; namespace "urn:demo"; prefix d; }`);
console.log(module.argument); // demo
```

The package currently parses the generic YANG statement grammar into a source-located AST and includes a **partial form helper** for field metadata and safe, local type checks. It is not a full YANG compiler or validator: module resolution, schema compilation, XPath, `must`/`when`, features and deviations are not yet implemented. See [ARCHITECTURE.md](./ARCHITECTURE.md) for scope and design, [ROADMAP.md](./ROADMAP.md) for milestones, and [TESTING.md](./TESTING.md) for validation gates and coverage policy.

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

## Browser example

After building, serve the repository root over HTTP and open [`examples/browser-usage.html`](./examples/browser-usage.html). It parses the Sysrepo oven model in the browser and uses the AST to populate the `insert-food` timing enum. The example demonstrates syntax inspection only: it does not resolve typedefs, apply augments, or evaluate `must`/`when` constraints.

## Development

Requires Node.js 20+ for development tooling. The published runtime is ESM targeting ES2022 and uses no Node APIs.

```sh
npm install
npm test
npm run build
```
