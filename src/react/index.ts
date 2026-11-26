/** §208 — the engine's React layer, published under the `yang-browser-engine/react` sub-path. */
export {
  YangProvider, useYangSchema,
  type YangSchemaState, type YangProviderProps,
} from "./provider.js";
export {
  useFormModel, useFieldValidation, useDataValidation, useCandidates, useRestconfResource,
  type RestconfResourceState, type RestconfResourceOptions,
} from "./hooks.js";
export {
  useOptimisticEdit, validateOptimisticValues,
  type OptimisticEditOptions, type OptimisticEditOutcome, type OptimisticEditState,
  type OptimisticLocalVerdict, type OptimisticProblem, type OptimisticServerFailure,
  type OptimisticSubmitOptions,
} from "./optimistic.js";
export {
  createYangRunner,
  type YangRunner, type YangRunnerOptions, type YangRunnerTask, type YangWorkerTransport,
} from "./runner.js";
export { spawnYangWorker } from "./spawn.js";
export {
  handleYangTask, YangTaskCancelledError, compileSources,
  type YangTaskEnvironment,
} from "./worker-core.js";
export {
  YANG_WORKER_REQUEST_KINDS,
  type YangWorkerRequest, type YangWorkerReply,
  type YangCompileRequest, type YangCompileResult, type YangWorkerSchemaPayload,
} from "./worker-protocol.js";
