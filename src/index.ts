export * from "./yang/ast.js";
export * from "./yang/parser.js";
export * from "./yang/module-set.js";
export * from "./yang/compiler.js";
export * from "./xpath/xpath.js";
export * from "./xpath/yang-functions.js";
export * from "./xpath/accessible-tree.js";
export * from "./xpath/evaluate-constraints.js";
export * from "./validation/validate-instance.js";
export * from "./validation/candidates.js";
export * from "./forms/form-model.js";
export * from "./restconf/paths.js";

/** Feature-gated behavior planned for the next implementation layers. */
export interface EngineCapabilities {
  parser: "statement-grammar";
  moduleResolution: "planned";
  xpath: "planned";
  validation: "partial-form-types";
  browserOnlyRuntime: true;
}
export const capabilities: EngineCapabilities = {
  parser: "statement-grammar", moduleResolution: "planned", xpath: "planned", validation: "partial-form-types", browserOnlyRuntime: true,
};
