/** §208 — headless hooks over the form model, validation and RESTCONF resources. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CompiledYangSchema } from "../yang/compiler.js";
import type { InstanceValidationOptions, InstanceValidationResult } from "../validation/validate-instance.js";
import { validateDataTree } from "../validation/validate-instance.js";
import type { CandidateOptions, CandidateResult } from "../validation/candidates.js";
import { evaluateCandidates } from "../validation/candidates.js";
import {
  createFormModel, validateFormValue,
  type FormField, type FormModel, type FormModelOptions, type FormValidationResult,
} from "../forms/form-model.js";
import type { YangPathSegment } from "../restconf/paths.js";
import { createRestconfGetRequest, readRestconfData } from "../restconf/paths.js";
import type { RestconfClient, RestconfSendOptions } from "../restconf/client.js";
import { useYangSchema } from "./provider.js";

/** A stable options signature so a memoized model does not rebuild every render. */
function modelOptionsSignature(options: FormModelOptions): string {
  return options.module ?? "";
}

/** Form metadata of the current schema; `undefined` while loading/errored. */
export function useFormModel(options: FormModelOptions = {}): FormModel | undefined {
  const state = useYangSchema();
  // The options object may be a fresh literal per render; signature keeps the
  // memo honest for its scalar parts (module, features identity is stable).
  const signature = modelOptionsSignature(options);
  return useMemo(
    () => state.status === "ready" ? createFormModel(state.schema, options) : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, signature],
  );
}

/** Form-level validation of one field value; `undefined` without a field. */
export function useFieldValidation(
  field: FormField | undefined,
  value: unknown,
  crossReference?: Parameters<typeof validateFormValue>[2],
): FormValidationResult | undefined {
  return useMemo(
    () => field ? validateFormValue(field, value, crossReference) : undefined,
    [field, value, crossReference],
  );
}

/** Tree-level validation of an instance document against the provider's schema. */
export function useDataValidation(
  instance: Document | undefined,
  options: InstanceValidationOptions = {},
): InstanceValidationResult | undefined {
  const state = useYangSchema();
  return useMemo(
    () => state.status === "ready" && instance ? validateDataTree(state.schema, instance, options) : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, instance],
  );
}

/** Contextual candidates for one node path (enum/bits/boolean domains). */
export function useCandidates(
  instance: Document | undefined,
  path: string | undefined,
  options: CandidateOptions = {},
): CandidateResult | undefined {
  const state = useYangSchema();
  return useMemo(
    () => state.status === "ready" && instance && path !== undefined
      ? evaluateCandidates(state.schema, instance, path, options)
      : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, instance, path],
  );
}

/** Plain serializable RESTCONF resource state (§208): data stays raw JSON. */
export interface RestconfResourceState {
  status: "loading" | "ready" | "error";
  data: unknown;
  /** Error message text (RFC 8040 §7 messages included when the body carried them). */
  error: string | undefined;
  /** HTTP status when the server answered (undefined for transport errors). */
  httpStatus: number | undefined;
}

export interface RestconfResourceOptions {
  /** Extract the module-qualified node from the GET body (readRestconfData). */
  resource?: { module: string; name: string } | undefined;
  /** Extra send options (headers, signal, timeout) per request. */
  send?: RestconfSendOptions | undefined;
  /** Extract the data from the parsed JSON body; defaults to readRestconfData or the raw body. */
  select?: ((body: unknown) => unknown) | undefined;
}

/**
 * GET a RESTCONF data resource with loading/error state, cancellation on
 * unmount or path change, and an explicit `refetch`. Data is plain JSON —
 * structured-cloneable for workers and devtools (§208/§210).
 */
export function useRestconfResource(
  client: RestconfClient | undefined,
  path: readonly YangPathSegment[],
  options: RestconfResourceOptions = {},
): RestconfResourceState & { refetch: () => void } {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<RestconfResourceState>({ status: "loading", data: undefined, error: undefined, httpStatus: undefined });
  const pathKey = JSON.stringify(path);
  const sendKey = options.send ? JSON.stringify({ headers: options.send.headers }) : "";
  // Latest-run guard: only the newest effect may commit results.
  const run = useRef(0);
  useEffect(() => {
    if (!client) return;
    const token = ++run.current;
    const controller = new AbortController();
    // Keep previously loaded data visible while the next request is in flight.
    setState(previous => ({ status: "loading", data: previous.data, error: undefined, httpStatus: undefined }));
    client.send(createRestconfGetRequest(JSON.parse(pathKey)), {
      ...options.send,
      signal: controller.signal,
    }).then(async response => {
      const body = await response.json();
      if (token !== run.current) return;
      const selected = options.select ? options.select(body) : (options.resource ? readRestconfData(body, options.resource.module, options.resource.name) : body);
      setState({ status: "ready", data: selected, error: undefined, httpStatus: response.status });
    }).catch(error => {
      if (token !== run.current) return;
      if (controller.signal.aborted || (error as Error)?.name === "AbortError") return;
      setState({
        status: "error", data: undefined,
        error: error instanceof Error ? error.message : String(error),
        httpStatus: (error as { status?: number }).status,
      });
    });
    return () => {
      controller.abort();
      run.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, pathKey, sendKey, nonce]);
  const refetch = useCallback(() => setNonce(value => value + 1), []);
  return { ...state, refetch };
}

/** Re-export the schema context so a single React entry covers §208/§209. */
export { YangProvider, useYangSchema, type YangSchemaState, type YangProviderProps } from "./provider.js";
export type { CompiledYangSchema };
