# Static-export recipe (Next.js)

How to deploy the engine in a Next.js site built with `output: 'export'` —
prerendered static files, no server runtime, the whole application running in
the browser against a RESTCONF API (RFC 8040, optionally RFC 8527 NMDA).
The engine stays framework-neutral; this recipe is about the build and
deployment constraints around it. A runnable App Router example is in
`examples/next-static/` (ROADMAP Stage 8.6, Next.js 16.4.6). Its E2E checks
build and serve the exported files, discover the oven module through the mock
YANG Library, validate and PATCH configuration, and invoke an RPC in Chromium.
The separate `next-static:e2e:basepath` run repeats that path under
`/yang-console`.

From the repository root, start the mock in one terminal and build the site:

```sh
npm run next-static:serve
npm run next-static:build
```

The export is written to `examples/next-static/out/`. The browser defaults to
`http://127.0.0.1:8081/restconf`; set `NEXT_PUBLIC_RESTCONF_URL` at build time
to point at another RESTCONF API. To build under a URL prefix, set
`NEXT_PUBLIC_BASE_PATH` (for example `/yang-console`). The integration gates
are `npm run next-static:e2e` and `npm run next-static:e2e:basepath`; both need
the Playwright Chromium browser installed. `npm run next-static:check` checks
the server-free export and the dynamic engine chunk's 256 KiB raw-size budget.

Verify Next.js-specific behavior against the official documentation of the
version in use; the example pins Next.js as a development dependency.

## 1. Configuration: `withYangEngine`

```js
// next.config.mjs
import { withYangEngine } from "yang-browser-engine/next";

export default withYangEngine(
  { reactStrictMode: true },
  { basePath: process.env.NEXT_PUBLIC_BASE_PATH },
);
```

The helper sets what a static export needs — `output: 'export'`,
`images.unoptimized: true` — and refuses configs that contradict it
(an `output` other than `export`, an enabled image optimizer), because a bad
build would only fail at deploy time otherwise. Everything else passes
through untouched: no `rewrites`/`redirects`/`headers` keys are added (they do
not exist in static export either), no server runtime is invented, and the
input object is never mutated. The `basePath` option applies to both
`basePath` and `assetPrefix` when the caller has not set them: a site served
under a sub-path of the device or gateway needs both to resolve its chunks
and public assets.

In a monorepo that compiles the engine from TypeScript sources, add
`transpilePackages: ["yang-browser-engine"]` yourself; consuming the published
package (compiled to ES2022) needs no transpilation.

## 2. What a static export cannot do (plan around it)

- No API routes, no middleware, no `rewrites`/`redirects`/`headers`, no ISR,
  no default image optimizer. Every data-dependent operation runs on the
  client: the RESTCONF calls, the YANG Library discovery, validation, editing.
- Pages are prerendered **at build time**, where there is no DOM and no
  `DOMParser`. The engine ships `sideEffects: false` and touches no browser
  global at import time, so importing it in a prerendered module tree is safe;
  the moment anything calls `DOMParser`, the browser-only entry must be used
  (see App Router below).
- Routes that need runtime data — a data-node path, a list key — cannot be
  dynamic path segments: dynamic routes would need `generateStaticParams` for
  values known only at runtime. Use query parameters or the hash instead
  (`next/useSearchParams`, or `window.location.hash` for fully static hosts).
  E.g. `/interfaces/edit?path=/ietf-interfaces:interfaces/interface=eth0`.
- `NEXT_PUBLIC_*` values are inlined into the public bundle: no secrets, no
  tokens, no RESTCONF credentials in them — the RESTCONF client keeps tokens
  in memory (`GUIDE.md` §9) and never reads env vars itself.
- Calls to the RESTCONF API are cross-origin unless the static files are
  served by the same origin (or the same reverse proxy): deployment must
  provide CORS (allowed origin; `Authorization`/`Content-Type`/`Accept`
  headers; `PUT`/`PATCH`/`DELETE`/`OPTIONS` methods; exposed `ETag`,
  `Location`, `Last-Modified`) or same-origin hosting. The engine's
  `RestconfNetworkError` carries the CORS checklist when a browser blocks the
  preflight. An HTTPS page cannot call a plain-HTTP RESTCONF endpoint
  (mixed content).

## 3. Routing guidance

- **Data-node paths and list keys live in search parameters or the hash**, not
  in path segments (see above). Read them in a client component, e.g.
  `useSearchParams().get("path")`, and keep `useSearchParams` calls inside a
  `<Suspense>` boundary — otherwise the whole page falls back to client-side
  prerendering.
- `trailingSlash: true` produces `out/page/index.html` files that static
  hosts (devices, gateways, Caddy) serve without extra rewrite rules;
  `trailingSlash: false` produces `page.html` and needs the host to try
  extensions. Pick `true` for static hosting appliances.
- `basePath`/`assetPrefix` must match the deployment path (see §1); the
  precompiled-schema URL and the RESTCONF base URL are your own settings and
  should be passed as runtime configuration (a `NEXT_PUBLIC_` constant is fine
  for a URL, never for credentials).

## 4. Where the engine runs (App Router and Pages Router)

- **App Router**: no Server Component may call the engine's browser-dependent
  entries (`DOMParser`, `createFormModel` on a live document, worker glue).
  Components that compile, validate or render forms are client components:
  mark them `"use client"` and let `YangProvider` initialize the engine in an
  effect — the first prerendered render shows the provider's `loading` state,
  so hydration cannot mismatch (guaranteed by `tests/react-hooks.test.ts`).
  Optionally wrap the page in `next/dynamic(..., { ssr: false })` to skip the
  prerendered placeholder entirely.
- **Pages Router**: same rule — `dynamic import(() => import('…'), { ssr:
  false })` around the engine-consuming component; static prerendering only
  ever sees the loading placeholder.
- The compiler/validation boundary: `createYangRunner({ worker:
  spawnYangWorker() })` moves compilation and validation to a module worker
  (bundler-native `new Worker(new URL(…), { type: "module" })` — webpack 5 and
  turbopack emit the worker chunk automatically, base path included). The spec
  limits a single synchronous XPath expression's interruptibility — the worker
  plus `task.cancel()` is the escape hatch for long-running stores.

## 5. Content-Security-Policy notes

The engine performs no `eval` and no `new Function` — the pattern subset that
would need dynamic compilation stays `pending`/`indeterminate` by design, so a
CSP without `unsafe-eval` is supportable. The directives that matter:

- `connect-src`: every origin the engine talks to through the injected fetch —
  the RESTCONF origin (and `EventSource` for notification streams), plus the
  origin serving the precompiled `yang-schema.json` when it differs from the
  page's.
- `worker-src 'self'`: module workers are spawned from the exported bundle
  itself.
- `script-src 'self'`: nothing beyond the static chunks; the engine adds no
  inline scripts.
- No `eval` with the `wasm-unsafe-eval` exception or trusted-types escape
  hatches is needed.

## 6. Engine assets at deploy time

- **Precompiled schema** (recommended): `yang-browser-engine precompile
  <sources> --out public/` writes `yang-schema.json`, verbatim module texts
  and `yang-manifest.json` into `public/`, so the browser fetches them as
  static files (`deserializeCompiledSchema`; under `basePath` the URL needs
  the prefix). Audit the bundle against the device with
  `findSchemaLibraryMismatches` before trusting it.
- **Fallback**: load the module set from the server's YANG Library with
  `createRestconfModuleLoader` and compile in the browser — same pages, no
  build-time artifact needed, at the cost of parsing untrusted-sized sources
  in the client (see the budgets in `GUIDE.md` §10).
