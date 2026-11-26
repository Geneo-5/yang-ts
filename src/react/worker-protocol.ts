/** §210 — messages between the UI thread and the YANG worker. Plain data only: every field survives `postMessage` structured cloning. */
import type { CompilerDiagnostic } from "../yang/compiler.js";

/** Compile raw module/submodule sources into one compiled schema. */
export interface YangCompileRequest {
  kind: "compile";
  id: number;
  /** Complete source texts; the worker parses each and resolves the closure (no loader: pass everything inline). */
  sources: readonly string[];
  /** Compiler options minus anything non-cloneable (budget kept; loaders cannot cross the boundary). */
  enabledFeatures?: readonly string[];
  maxSchemaNodes?: number;
}

export interface YangWorkerSchemaPayload {
  id: number;
  kind: "validate" | "candidates" | "form-model";
  /** The compiled schema is plain data and clones natively through postMessage. */
  schema: unknown;
  /** Instance XML text — parsed inside the task handler with the host's parser. */
  instance?: string;
  /** Candidate path (schema-node path, e.g. `/interfaces/interface/speed`). */
  path?: string;
  /** validateDataTree options (plain subset: includeState, deadlineMs). */
  includeState?: boolean;
  deadlineMs?: number;
}

export type YangWorkerRequest = YangCompileRequest | YangWorkerSchemaPayload | { kind: "cancel"; id: number };

/** Successful reply for request `id`. */
export interface YangWorkerResultReply { id: number; type: "result"; value: unknown }
/** Failed reply: name/message only (Error objects do not clone usefully). */
export interface YangWorkerErrorReply { id: number; type: "error"; name: string; message: string }
/** The task was cancelled before completion (or after a `cancel`). */
export interface YangWorkerCancelledReply { id: number; type: "cancelled" }
export type YangWorkerReply = YangWorkerResultReply | YangWorkerErrorReply | YangWorkerCancelledReply;

/** Compile diagnostics surface as a result, never an error: they are data. */
export interface YangCompileResult {
  schema: unknown;
  diagnostics: readonly CompilerDiagnostic[];
}

/** Names the engine worker understands — check with `isYangWorkerRequest` in custom hosts. */
export const YANG_WORKER_REQUEST_KINDS = ["compile", "validate", "candidates", "form-model", "cancel"] as const;
