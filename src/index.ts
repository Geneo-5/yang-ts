export * from "./yang/ast.js";
export * from "./yang/parser.js";
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
