/**
 * §210 — run engine tasks off-thread when a Worker is available, otherwise on
 * the main thread with the SAME handler (no answer drift). The transport is
 * parameterized so tests can emulate `postMessage` channels exactly.
 *
 * Worker transport: replies route by request id through one `onmessage`, so
 * concurrent tasks never clobber each other. Instance XML crosses as TEXT
 * (parsed inside the task with the host's parser); compiled schemas cross as
 * plain data (structured clone). `task.cancel()` settles the promise as
 * cancelled and posts a cancel — long tasks honor it cooperatively where the
 * engine checks signals (validate visits; see ROADMAP §35 for the sync XPath
 * limitation).
 */
import type { CompiledYangSchema } from "../yang/compiler.js";
import type { InstanceValidationResult } from "../validation/validate-instance.js";
import type { CandidateResult } from "../validation/candidates.js";
import type { FormModel } from "../forms/form-model.js";
import type { YangCompileRequest, YangCompileResult, YangWorkerReply, YangWorkerRequest, YangWorkerSchemaPayload } from "./worker-protocol.js";
import { handleYangTask, YangTaskCancelledError } from "./worker-core.js";

/** Minimal Worker-like surface (browser `Worker` satisfies it; tests emulate). */
export interface YangWorkerTransport {
  postMessage(message: YangWorkerRequest): void;
  set onmessage(handler: ((event: { data: YangWorkerReply }) => void) | null);
  terminate(): void;
}

export interface YangRunnerOptions {
  /** Worker to delegate to; absent → tasks run on the main thread (fallback). */
  worker?: YangWorkerTransport | undefined;
  /** Parser for instance XML (main-thread fallback and worker host glue both need one). */
  parseXml(text: string): Document;
}

/** A task promise that can be cancelled (settles as a `YangTaskCancelledError`). */
export interface YangRunnerTask<T> extends Promise<T> {
  cancel(): void;
}

/** One long-lived runner; reuse it across tasks. */
export interface YangRunner {
  compile(sources: readonly string[], options?: { enabledFeatures?: readonly string[]; maxSchemaNodes?: number }): YangRunnerTask<YangCompileResult>;
  validate(schema: CompiledYangSchema, instanceXml: string, options?: { includeState?: boolean; deadlineMs?: number }): YangRunnerTask<InstanceValidationResult>;
  candidates(schema: CompiledYangSchema, instanceXml: string, path: string): YangRunnerTask<CandidateResult>;
  formModel(schema: CompiledYangSchema): YangRunnerTask<FormModel>;
  /** Reject everything still pending (shutdown); the transport itself is left alone. */
  cancelAll(): void;
}

interface PendingTask {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  settled: boolean;
  cancelRequested: boolean;
}

export function createYangRunner(options: YangRunnerOptions): YangRunner {
  const pending = new Map<number, PendingTask>();
  let nextId = 1;

  const settle = (reply: YangWorkerReply): void => {
    const task = pending.get(reply.id);
    if (!task) return;
    pending.delete(reply.id);
    task.settled = true;
    if (reply.type === "result" && task.cancelRequested) task.reject(new YangTaskCancelledError());
    else if (reply.type === "result") task.resolve(reply.value);
    else if (reply.type === "error") {
      const error = new Error(reply.message);
      error.name = reply.name;
      task.reject(error);
    } else task.reject(new YangTaskCancelledError());
  };

  if (options.worker) options.worker.onmessage = ({ data }) => settle(data);

  const dispatch = (id: number, request: YangWorkerRequest): void => {
    if (options.worker) options.worker.postMessage({ ...request, id });
    else {
      handleYangTask(request, { parseXml: options.parseXml }).then(
        value => settle({ id, type: "result", value }),
        (error: unknown) => settle({
          id, type: "error",
          name: (error as Error).name,
          message: (error as Error).message,
        }),
      );
    }
  };

  const run = <T,>(request: YangWorkerRequest): YangRunnerTask<T> => {
    const id = nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as unknown as (value: unknown) => void, reject, settled: false, cancelRequested: false });
      dispatch(id, request);
    }) as YangRunnerTask<T>;
    promise.cancel = () => {
      // Settle locally at once (the worker may still answer later; late
      // replies ride out through the cancelled id) and stop the worker side.
      settle({ id, type: "cancelled" });
      if (options.worker) options.worker.postMessage({ kind: "cancel", id });
    };
    return promise;
  };

  return {
    compile(sources, compileOptions = {}) {
      const request: YangCompileRequest = {
        kind: "compile", id: 0, sources,
        ...(compileOptions.enabledFeatures ? { enabledFeatures: compileOptions.enabledFeatures } : {}),
        ...(compileOptions.maxSchemaNodes !== undefined ? { maxSchemaNodes: compileOptions.maxSchemaNodes } : {}),
      };
      return run(request);
    },
    validate(schema, instanceXml, validateOptions = {}) {
      const payload: YangWorkerSchemaPayload = {
        kind: "validate", id: 0, schema, instance: instanceXml,
        ...(validateOptions.includeState !== undefined ? { includeState: validateOptions.includeState } : {}),
        ...(validateOptions.deadlineMs !== undefined ? { deadlineMs: validateOptions.deadlineMs } : {}),
      };
      return run(payload);
    },
    candidates(schema, instanceXml, path) {
      return run({ kind: "candidates", id: 0, schema, instance: instanceXml, path } satisfies YangWorkerSchemaPayload & YangWorkerRequest);
    },
    formModel(schema) {
      return run({ kind: "form-model", id: 0, schema } satisfies YangWorkerSchemaPayload & YangWorkerRequest);
    },
    cancelAll() {
      for (const [id, task] of [...pending]) {
        if (!task.settled) task.reject(new YangTaskCancelledError());
        pending.delete(id);
        if (options.worker) options.worker.postMessage({ kind: "cancel", id });
      }
    },
  };
}
