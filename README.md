# yang-browser-engine

Browser-first TypeScript foundation for compiling YANG 1.1 schemas and exposing them to user interfaces. The project is at its parser foundation stage; it is not yet a complete YANG compiler or validator.

```ts
import { parseYang } from "yang-browser-engine";

const module = parseYang(`module demo { yang-version 1.1; namespace "urn:demo"; prefix d; }`);
console.log(module.argument); // demo
```

The package currently parses the generic YANG statement grammar into a source-located AST. Module resolution, schema compilation, XPath, type validation, `must`/`when`, features and deviations are planned and explicitly not implemented yet. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the scope and design, [ROADMAP.md](./ROADMAP.md) for milestones, and [TESTING.md](./TESTING.md) for validation gates and coverage policy.

## Browser example

After building, serve the repository root over HTTP and open [`examples/browser-usage.html`](./examples/browser-usage.html). It parses the Sysrepo oven model in the browser and uses the AST to populate the `insert-food` timing enum. The example demonstrates syntax inspection only: it does not resolve typedefs, apply augments, or evaluate `must`/`when` constraints.

## Development

Requires Node.js 20+ for development tooling. The published runtime is ESM targeting ES2022 and uses no Node APIs.

```sh
npm install
npm test
npm run build
```
