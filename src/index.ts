export * from "./yang/ast.js";
export * from "./yang/parser.js";

/** Feature-gated behavior planned for the next implementation layers. */
export interface EngineCapabilities {
  parser: "statement-grammar";
  moduleResolution: "planned";
  xpath: "planned";
  validation: "planned";
  browserOnlyRuntime: true;
}
export const capabilities: EngineCapabilities = {
  parser: "statement-grammar", moduleResolution: "planned", xpath: "planned", validation: "planned", browserOnlyRuntime: true,
};
