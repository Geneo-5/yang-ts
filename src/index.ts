/**
 * The published public API: exactly the surface documented in README.md and
 * exercised by `tests/public-api.test.ts` and `tests/bundle-smoke.test.ts`.
 * Internal helpers stay reachable through `./internal.ts` only.
 */
export {
  parseYang,
} from "./yang/parser.js";
export { YangSyntaxError } from "./yang/ast.js";
export {
  resolveModuleSet,
} from "./yang/module-set.js";
export {
  compileYangModules,
} from "./yang/compiler.js";
export {
  buildAccessibleTree,
} from "./xpath/accessible-tree.js";
export {
  createConstraintEvaluator,
} from "./xpath/evaluate-constraints.js";
export {
  validateDataTree,
} from "./validation/validate-instance.js";
export {
  evaluateCandidates,
} from "./validation/candidates.js";
export {
  createFormModel,
  validateFormValue,
  canonicalFormOf,
} from "./forms/form-model.js";
export {
  createRestconfModuleLoader,
} from "./restconf/library-loader.js";
export {
  nodeToRestconfDataPath,
  nodeToRestconfDatastorePath,
  nodeToXPath,
  restconfRpcPath,
  createRestconfGetRequest,
  createRestconfDatastoreRequest,
  createRestconfNmdaProbeRequest,
  createRestconfSetRequest,
  createRestconfAddRequest,
  createRestconfUpdateRequest,
  createRestconfDeleteRequest,
  createRestconfRpcRequest,
  readRestconfData,
  readRestconfRpcOutput,
} from "./restconf/paths.js";

export type { YangDocument, YangModuleSet, ModuleSetDiagnostic, ModuleSetConstraints } from "./yang/module-set.js";
export type { CompiledSchemaNode, CompiledYangSchema } from "./yang/compiler.js";
export type { YangModule, YangStatement } from "./yang/ast.js";
export type { FormField, FormControlKind, FormValidationStatus, FormRpcOperation } from "./forms/form-model.js";
export type { InstanceValidationResult, ValidationIssue, ValidationIssueCode } from "./validation/validate-instance.js";
export type { CandidateEvaluation } from "./validation/candidates.js";
export type { ConstraintEvaluation, ConstraintEvaluator } from "./xpath/evaluate-constraints.js";
export type { RestconfDataRequest, RestconfRpcRequest, RestconfQueryParameters, RestconfDatastore, YangPathSegment, YangPathKey, RestconfScalar } from "./restconf/paths.js";
export type { RestconfLoaderOptions, YangLibraryInventory, YangLibraryModuleEntry } from "./restconf/library-loader.js";
export type { CompiledYangXPath } from "./xpath/xpath.js";

/** Feature-gated behavior of the shipped engine, kept honest with the docs. */
export interface EngineCapabilities {
  parser: "implemented";
  moduleResolution: "implemented";
  xpath: "implemented";
  validation: "partial";
  browserOnlyRuntime: true;
}
export const capabilities: EngineCapabilities = {
  parser: "implemented", moduleResolution: "implemented", xpath: "implemented", validation: "partial", browserOnlyRuntime: true,
};
