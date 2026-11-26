/**
 * §210 — spawns the module worker next to its own chunk:
 * `new Worker(new URL(...), { type: "module" })` is the bundler-recognized
 * spelling (Vite/webpack/esbuild copy the glue file). Pair the result with
 * `createYangRunner({ worker, parseXml })`; when spawning is impossible
 * (SSR, tests, old engines), call `createYangRunner` without a worker and
 * the identical core handler runs on the invoking thread.
 */
import type { YangRunnerOptions } from "./runner.js";

export function spawnYangWorker(options?: { name?: string }): Worker {
  // `type` must stay static (Vite/webpack parse this shape literally); any
  // dynamic spawn options come after it.
  return new Worker(new URL("./worker-glue.js", import.meta.url), { type: "module", name: options?.name ?? "" });
}

export type { YangRunnerOptions };
