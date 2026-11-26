import type {
  CompiledIdentity,
  CompiledOperation,
  CompiledSchemaNode,
  CompiledYangSchema,
  CompilerDiagnostic,
  SchemaNodeKind,
} from "./compiler.js";
import type { SourceLocation, YangModule, YangStatement } from "./ast.js";

/**
 * The serialized form exists so compilation can happen at build time (the
 * precompile CLI) and the browser only loads the result: plain, versioned
 * JSON data with no live YangStatement graph, no DOM references and no
 * engine internals beyond the documented shape.
 */
export const COMPILED_SCHEMA_FORMAT = "yang-browser-engine/compiled-schema";

/** Bump when the CompiledYangSchema shape changes incompatibly. */
export const COMPILED_SCHEMA_VERSION = 1;

export interface CompiledSchemaJson {
  format: string;
  version: number;
  schema: CompiledYangSchema;
}

export class CompiledSchemaFormatError extends Error {
  constructor(
    readonly code: "format" | "version" | "structure" | "unsupported-value",
    message: string,
  ) {
    super(message);
    this.name = "CompiledSchemaFormatError";
  }
}

const NODE_KINDS: ReadonlySet<string> = new Set<SchemaNodeKind>([
  "container", "list", "leaf", "leaf-list", "choice", "case", "anydata", "anyxml",
]);
const OPERATION_KINDS: ReadonlySet<string> = new Set(["rpc", "action", "notification"]);

/* ------------------------------------------------------------------ */
/* Serialization: deep-clone the compiled schema as pure JSON data.    */
/* ------------------------------------------------------------------ */

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "function") return "a function";
  if (typeof value === "symbol") return "a symbol";
  if (typeof value === "bigint") return "a bigint";
  if (typeof value !== "object") return `the ${typeof value} ${JSON.stringify(value)}`;
  const nodeType = (value as { nodeType?: unknown }).nodeType;
  if (typeof nodeType === "number") {
    const nodeName = (value as { nodeName?: unknown }).nodeName;
    return `a DOM node${typeof nodeName === "string" ? ` (${nodeName})` : ""}`;
  }
  const name = (value as object).constructor?.name;
  return name && name !== "Object" ? `a ${name} instance` : "an exotic object";
}

function describePath(path: readonly (string | number)[]): string {
  if (path.length === 0) return "the schema";
  const rendered = path.map(
    segment => typeof segment === "number" ? `[${segment}]` : `.${segment}`,
  ).join("");
  return rendered.startsWith(".") ? rendered.slice(1) : rendered;
}

function cloneData(value: unknown, where: readonly (string | number)[]): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (item === undefined) {
        throw new CompiledSchemaFormatError(
          "unsupported-value",
          `JSON cannot carry undefined at ${describePath([...where, index])}`,
        );
      }
      return cloneData(item, [...where, index]);
    });
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const clone: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        const item = (value as Record<string, unknown>)[key];
        if (item === undefined) continue;
        clone[key] = cloneData(item, [...where, key]);
      }
      return clone;
    }
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new CompiledSchemaFormatError(
    "unsupported-value",
    `Serialization only carries JSON data: ${describePath(where)} holds ${describeValue(value)}`,
  );
}

/**
 * Serialize a compiled schema as the versioned JSON envelope. Throws
 * `CompiledSchemaFormatError` with code `unsupported-value` when the schema
 * carries anything a JSON file cannot (functions, DOM nodes, symbols,
 * non-finite numbers) rather than silently dropping it.
 */
export function serializeCompiledSchema(schema: CompiledYangSchema): CompiledSchemaJson {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new CompiledSchemaFormatError("structure", "Expected a CompiledYangSchema object");
  }
  return {
    format: COMPILED_SCHEMA_FORMAT,
    version: COMPILED_SCHEMA_VERSION,
    schema: cloneData(schema, []) as CompiledYangSchema,
  };
}

/* ------------------------------------------------------------------ */
/* Deserialization: validate the envelope and revive the structure.    */
/* ------------------------------------------------------------------ */

function fail(message: string): never {
  throw new CompiledSchemaFormatError("structure", message);
}

function stringOf(value: unknown, where: string): string {
  if (typeof value !== "string") return fail(`${where}: expected a string, got ${describeValue(value)}`);
  return value;
}

function numberTag(value: unknown): string {
  return value === undefined ? "missing" : JSON.stringify(value);
}

function stringArrayOf(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) return fail(`${where}: expected an array of strings`);
  return value.map((item, index) => stringOf(item, `${where}[${index}]`));
}

function statementArrayOf(value: unknown, where: string): YangStatement[] {
  if (!Array.isArray(value)) return fail(`${where}: expected an array of statements`);
  return value.map((item, index) => revStatement(item, `${where}[${index}]`));
}

function revLocation(value: unknown, where: string): SourceLocation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${where}: location must be an object`);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.offset !== "number" || typeof raw.line !== "number" || typeof raw.column !== "number") {
    return fail(`${where}: location needs numeric offset, line and column`);
  }
  return { offset: raw.offset, line: raw.line, column: raw.column };
}

function revStatement(value: unknown, where: string): YangStatement {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${where}: expected a statement object, got ${describeValue(value)}`);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.keyword !== "string") return fail(`${where}: keyword must be a string`);
  if (!("location" in raw)) return fail(`${where}: location is required`);
  const statement: YangStatement = {
    keyword: raw.keyword,
    children: statementArrayOf(raw.children, `${where}.children`),
    location: revLocation(raw.location, where),
  };
  if (raw.argument !== undefined) statement.argument = stringOf(raw.argument, `${where}.argument`);
  return statement;
}

function revNode(value: unknown, where: string): CompiledSchemaNode {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${where}: expected a schema node object, got ${describeValue(value)}`);
  }
  const raw = value as Record<string, unknown>;
  const kind = stringOf(raw.kind, `${where}.kind`);
  if (!NODE_KINDS.has(kind)) return fail(`${where}: unknown schema node kind ${JSON.stringify(kind)}`);
  const node: CompiledSchemaNode = {
    kind: kind as SchemaNodeKind,
    name: stringOf(raw.name, `${where}.name`),
    module: stringOf(raw.module, `${where}.module`),
    namespace: stringOf(raw.namespace, `${where}.namespace`),
    declaredIn: stringOf(raw.declaredIn, `${where}.declaredIn`),
    path: stringOf(raw.path, `${where}.path`),
    config: typeof raw.config === "boolean"
      ? raw.config
      : fail(`${where}: config must be a boolean`),
    keys: stringArrayOf(raw.keys, `${where}.keys`),
    typedefChain: statementArrayOf(raw.typedefChain, `${where}.typedefChain`),
    typedefChainModules: stringArrayOf(raw.typedefChainModules, `${where}.typedefChainModules`),
    must: statementArrayOf(raw.must, `${where}.must`),
    whenConstraints: statementArrayOf(raw.whenConstraints, `${where}.whenConstraints`),
    whenHolders: stringArrayOf(raw.whenHolders, `${where}.whenHolders`),
    ifFeatures: stringArrayOf(raw.ifFeatures, `${where}.ifFeatures`),
    featureRequirements: (() => {
      if (!Array.isArray(raw.featureRequirements)) {
        return fail(`${where}: featureRequirements must be an array`);
      }
      return raw.featureRequirements.map((entry, index): { module: string; expression: string } => {
        const requirement = asPlainObject(entry, `${where}.featureRequirements[${index}]`);
        return {
          module: stringOf(requirement.module, `${where}.featureRequirements[${index}].module`),
          expression: stringOf(requirement.expression, `${where}.featureRequirements[${index}].expression`),
        };
      });
    })(),
    properties: (() => {
      const rawProperties = asPlainObject(raw.properties, `${where}.properties`);
      const properties: Record<string, YangStatement[]> = {};
      for (const key of Object.keys(rawProperties)) {
        properties[key] = statementArrayOf(rawProperties[key], `${where}.properties.${key}`);
      }
      return properties;
    })(),
    deviations: statementArrayOf(raw.deviations, `${where}.deviations`),
    source: revStatement(raw.source, `${where}.source`),
    children: (() => {
      if (!Array.isArray(raw.children)) return fail(`${where}: children must be an array`);
      return raw.children.map((child, index) => revNode(child, `${where}.children[${index}]`));
    })(),
  };
  if (raw.type !== undefined) node.type = revStatement(raw.type, `${where}.type`);
  if (raw.resolvedType !== undefined) node.resolvedType = stringOf(raw.resolvedType, `${where}.resolvedType`);
  if (raw.featureDisabledValues !== undefined) {
    node.featureDisabledValues = stringArrayOf(raw.featureDisabledValues, `${where}.featureDisabledValues`);
  }
  return node;
}

function asPlainObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${where}: expected an object, got ${describeValue(value)}`);
  }
  return value as Record<string, unknown>;
}

function revNodeArray(value: unknown, where: string): CompiledSchemaNode[] {
  if (!Array.isArray(value)) return fail(`${where}: expected an array of schema nodes`);
  return value.map((item, index) => revNode(item, `${where}[${index}]`));
}

function revOperation(value: unknown, where: string): CompiledOperation {
  const raw = asPlainObject(value, where);
  const kind = stringOf(raw.kind, `${where}.kind`);
  if (!OPERATION_KINDS.has(kind)) return fail(`${where}: unknown operation kind ${JSON.stringify(kind)}`);
  if (!Array.isArray(raw.schemaPath)) return fail(`${where}: schemaPath must be an array`);
  return {
    kind: kind as CompiledOperation["kind"],
    name: stringOf(raw.name, `${where}.name`),
    module: stringOf(raw.module, `${where}.module`),
    path: stringOf(raw.path, `${where}.path`),
    schemaPath: raw.schemaPath.map((segment, index) => {
      const step = asPlainObject(segment, `${where}.schemaPath[${index}]`);
      return {
        module: stringOf(step.module, `${where}.schemaPath[${index}].module`),
        name: stringOf(step.name, `${where}.schemaPath[${index}].name`),
      };
    }),
    source: revStatement(raw.source, `${where}.source`),
    data: revNodeArray(raw.data, `${where}.data`),
    input: revNodeArray(raw.input, `${where}.input`),
    output: revNodeArray(raw.output, `${where}.output`),
  };
}

function revModule(value: unknown, where: string): YangModule {
  const statement = revStatement(value, where);
  if (statement.keyword !== "module" && statement.keyword !== "submodule") {
    return fail(`${where}: expected a module or submodule statement, got ${JSON.stringify(statement.keyword)}`);
  }
  if (!statement.argument) return fail(`${where}: module name is required`);
  return statement as YangModule;
}

/**
 * Validate a serialized compiled schema and return it. The argument is
 * typically `JSON.parse(...)` output; the returned value references the
 * same objects (no copy is taken), so treat it as the schema afterwards.
 * Throws `CompiledSchemaFormatError` with code `format` (not this format),
 * `version` (older or newer payload — recompile with the matching release)
 * or `structure` (payload does not match the compiled schema shape) so
 * callers can distinguish a stale artifact from genuine corruption.
 */
export function deserializeCompiledSchema(payload: unknown): CompiledYangSchema {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new CompiledSchemaFormatError(
      "format",
      `Expected a compiled schema envelope object, got ${describeValue(payload)}`,
    );
  }
  const envelope = payload as Record<string, unknown>;
  if (envelope.format !== COMPILED_SCHEMA_FORMAT) {
    throw new CompiledSchemaFormatError(
      "format",
      `Unknown compiled schema format ${JSON.stringify(envelope.format ?? null)}; expected ${JSON.stringify(COMPILED_SCHEMA_FORMAT)}`,
    );
  }
  if (typeof envelope.version !== "number" || !Number.isFinite(envelope.version) || envelope.version !== COMPILED_SCHEMA_VERSION) {
    throw new CompiledSchemaFormatError(
      "version",
      `Compiled schema is version ${numberTag(envelope.version)}; this engine understands version ${COMPILED_SCHEMA_VERSION}. Recompile the schema with the precompile step of a matching release.`,
    );
  }
  const rawSchema = asPlainObject(envelope.schema, "schema");
  if (!Array.isArray(rawSchema.roots)) return fail("schema: roots must be an array");
  if (!Array.isArray(rawSchema.operations)) return fail("schema: operations must be an array");
  if (!Array.isArray(rawSchema.identities)) return fail("schema: identities must be an array");
  if (!Array.isArray(rawSchema.diagnostics)) return fail("schema: diagnostics must be an array");
  if (!Array.isArray(rawSchema.modules)) return fail("schema: modules must be an array");
  if (!Array.isArray(rawSchema.submodules)) return fail("schema: submodules must be an array");
  const identities: CompiledIdentity[] = rawSchema.identities.map((entry, index) => {
    const raw = asPlainObject(entry, `schema.identities[${index}]`);
    return {
      name: stringOf(raw.name, `schema.identities[${index}].name`),
      module: stringOf(raw.module, `schema.identities[${index}].module`),
      namespace: stringOf(raw.namespace, `schema.identities[${index}].namespace`),
      bases: stringArrayOf(raw.bases, `schema.identities[${index}].bases`),
      source: revStatement(raw.source, `schema.identities[${index}].source`),
    };
  });
  const diagnostics: CompiledYangSchema["diagnostics"] = rawSchema.diagnostics.map((entry, index) => {
    const raw = asPlainObject(entry, `schema.diagnostics[${index}]`);
    return {
      code: stringOf(raw.code, `schema.diagnostics[${index}].code`) as CompilerDiagnostic["code"],
      message: stringOf(raw.message, `schema.diagnostics[${index}].message`),
      module: stringOf(raw.module, `schema.diagnostics[${index}].module`),
      source: revStatement(raw.source, `schema.diagnostics[${index}].source`),
    };
  });
  return {
    roots: revNodeArray(rawSchema.roots, "schema.roots"),
    operations: (Array.isArray(rawSchema.operations)
      ? rawSchema.operations.map((entry, index) => revOperation(entry, `schema.operations[${index}]`))
      : fail("schema: operations must be an array")),
    identities,
    diagnostics,
    modules: rawSchema.modules.map((entry, index) => revModule(entry, `schema.modules[${index}]`)),
    submodules: rawSchema.submodules.map((entry, index) => revModule(entry, `schema.submodules[${index}]`)),
  };
}
