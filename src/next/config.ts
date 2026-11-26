/**
 * Stage 8.5 — `withYangEngine(nextConfig)`: the Next.js configuration helper
 * for a static-export site that runs the whole YANG engine in the browser.
 *
 * A build-time object transform with no `next` import (the helper stays a
 * plain function the config file can call from any version of Next.js):
 * it sets the export-only defaults the engine's deployment story needs,
 * refuses configs that contradict them (a conflicting setting would produce
 * an `out/` that silently requires a Node server), and passes everything
 * else through untouched — including `basePath`/`assetPrefix` the caller set.
 *
 * The precompiled schema (`yang-browser-engine precompile`) and the module
 * worker (`spawnYangWorker`) need no further configuration: `public/` assets
 * and `new Worker(new URL(…))` are handled by the bundler — see NEXTJS.md.
 */

export interface YangNextConfig {
  /** Any Next.js config key passes through unchanged. */
  [key: string]: unknown;
  output?: string | undefined;
  basePath?: string | undefined;
  assetPrefix?: string | undefined;
  images?: { [key: string]: unknown; unoptimized?: boolean | undefined };
}

export interface WithYangEngineOptions {
  /**
   * The site is served under a sub-path (device or gateway): applied to
   * `basePath` and, when the caller did not point assets elsewhere, to
   * `assetPrefix`. Explicit caller values are never overridden.
   */
  basePath?: string | undefined;
}

export function withYangEngine(
  nextConfig: YangNextConfig | undefined,
  options: WithYangEngineOptions = {},
): YangNextConfig {
  const config: YangNextConfig = { ...nextConfig };
  if (config.output !== undefined && config.output !== "export") {
    throw new Error(
      `withYangEngine is for a static export (output: 'export'); the config sets output: '${config.output}'. ` +
        "The engine needs no server runtime, so drop the override or drop the helper.",
    );
  }
  const images: { [key: string]: unknown; unoptimized?: boolean | undefined } = { ...config.images };
  if (images.unoptimized === false) {
    throw new Error(
      "withYangEngine requires images.unoptimized: true — an exported site has no image optimizer server to call.",
    );
  }
  images.unoptimized = true;
  config.images = images;
  config.output = "export";
  if (options.basePath !== undefined) {
    if (config.basePath === undefined) config.basePath = options.basePath;
    if (config.assetPrefix === undefined) config.assetPrefix = options.basePath;
  }
  return config;
}
