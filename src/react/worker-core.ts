/**
 * §210 — the pure worker task handler. Imports ONLY the engine core, so a
 * module worker entry can load it directly; the same handler runs on the
 * main thread when workers are unavailable (identical answers, no fallback
 * drift). Everything returned is plain data (structured-cloneable).
 */
import { parseYang } from "../yang/parser.js";
import { resolveModuleSet } from "../yang/module-set.js";
import { compileYangModules, type CompilerDiagnostic, type CompiledYangSchema } from "../yang/compiler.js";
import { validateDataTree } from "../validation/validate-instance.js";
import { evaluateCandidates } from "../validation/candidates.js";
import { createFormModel } from "../forms/form-model.js";
import type {
  YangCompileRequest, YangCompileResult,
  YangWorkerRequest, YangWorkerSchemaPayload,
} from "./worker-protocol.js";

/** The host supplies the DOM parser (browser `DOMParser`, xmldom in tests/SSR). */
export interface YangTaskEnvironment {
  parseXml(text: string): Document;
  /** Optional cooperative cancellation for `validate` (checked at every element visit). */
  signal?: AbortSignal | undefined;
}

/** Compiled schema (incl. diagnostics) for a set of inline sources. */
export async function compileSources(request: YangCompileRequest): Promise<YangCompileResult> {
  const modules = request.sources.map(source => parseYang(source));
  const moduleSet = await resolveModuleSet(modules, { async loadModule() { return undefined; } });
  const schema = compileYangModules(moduleSet, {
    ...(request.enabledFeatures ? { enabledFeatures: new Set(request.enabledFeatures) } : {}),
    ...(request.maxSchemaNodes !== undefined ? { budget: { maxSchemaNodes: request.maxSchemaNodes } } : {}),
  });
  return { schema, diagnostics: schema.diagnostics };
}

/** Dispatch one request to the engine; throws on unknown kinds (protocol bugs are loud). */
export async function handleYangTask(request: YangWorkerRequest, env: YangTaskEnvironment): Promise<unknown> {
  if (request.kind === "cancel") {
    // Cancellation is signalled by the runner rejecting the corresponding
    // task; long tasks stop cooperatively through `env.signal` (validate).
    throw new YangTaskCancelledError();
  }
  if (request.kind === "compile") {
    const { schema, diagnostics } = await compileSources(request);
    return { schema, diagnostics };
  }
  const schema = request.schema as CompiledYangSchema;
  const instance = request.instance === undefined ? undefined : env.parseXml(request.instance);
  switch (request.kind) {
    case "validate":
      if (!instance) throw new Error("A validate request requires an `instance` XML string");
      return validateDataTree(schema, instance, {
        ...(request.includeState !== undefined ? { includeState: request.includeState } : {}),
        ...(request.deadlineMs !== undefined ? { deadlineMs: request.deadlineMs } : {}),
        ...(env.signal ? { signal: env.signal } : {}),
      });
    case "candidates":
      if (!instance) throw new Error("A candidates request requires an `instance` XML string");
      return evaluateCandidates(schema, instance, request.path ?? "", env.signal ? { signal: env.signal } : {});
    case "form-model":
      return createFormModel(schema, {});
  }
  throw new Error(`Unknown YANG worker request '${(request as { kind?: string }).kind}'`);
}

/** Error the runner recognizes as a cancelled task (maps to a `cancelled` reply). */
export class YangTaskCancelledError extends Error {
  constructor() {
    super("YANG worker task cancelled");
    this.name = "YangTaskCancelled";
  }
}
