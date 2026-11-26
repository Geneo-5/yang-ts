/**
 * The built-in type registry of RFC 7950 section 9 and the restriction
 * compatibility table of section 9.2.1, single-sourced here so the compiler,
 * the form model and future type code cannot drift apart.
 */

/** Every built-in type name of RFC 7950 section 9 (the type-independent list). */
export const BUILTIN_TYPES: ReadonlySet<string> = new Set([
  "binary", "bits", "boolean", "decimal64", "empty", "enumeration", "identityref", "instance-identifier",
  "int8", "int16", "int32", "int64", "leafref", "string", "uint8", "uint16", "uint32", "uint64", "union",
]);

/** Built-in types accepting each restriction statement (RFC 7950, section 9.2.1). */
export const RESTRICTION_BUILTINS: Readonly<Record<string, ReadonlySet<string>>> = {
  range: new Set(["int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64", "decimal64"]),
  length: new Set(["string", "binary"]),
  pattern: new Set(["string"]),
  path: new Set(["leafref"]),
  "require-instance": new Set(["leafref", "instance-identifier"]),
  "fraction-digits": new Set(["decimal64"]),
  base: new Set(["identityref"]),
  enum: new Set(["enumeration"]),
  bit: new Set(["bits"]),
};
