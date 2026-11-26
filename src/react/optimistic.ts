/**
 * §211 — optimistic edit flow as plain functions + one hook:
 *
 *   edit → `validateOptimisticValues` (valid / invalid / indeterminate with
 *   reasons) → decision (`invalid` blocks; `indeterminate` submits with the
 *   reasons visible — the server is the authority) → PATCH/PUT through the
 *   RESTCONF client → outcome with the server reconciliation (`etag`, the
 *   RFC 8040 §7 error fields, transport failures as text).
 *
 * Merge semantics: a value ABSENT from the map means "untouched" — absent
 * never triggers a required error locally (only the server knows what is
 * already stored). Everything the hook exposes is plain data (serializable).
 */
import { useCallback, useState } from "react";
import { RestconfRequestError } from "../restconf/client.js";
import type { RestconfClient, RestconfSendOptions } from "../restconf/client.js";
import { createRestconfSetRequest, createRestconfUpdateRequest, type RestconfDataRequest, type RestconfResourceData } from "../restconf/paths.js";
import { validateFormValue, type FormField, type FormModel } from "../forms/form-model.js";
import { formValuesToRestconfBody, type FormValues } from "../forms/restconf-body.js";

/** One problem, projected to plain data (code + message + why it stays pending). */
export interface OptimisticProblem {
  path: string;
  code: string;
  message: string;
  /** True for must/when/if-feature/pending checks the local pass cannot judge. */
  pending: boolean;
}

export interface OptimisticLocalVerdict {
  status: "valid" | "invalid" | "indeterminate";
  problems: readonly OptimisticProblem[];
}

/**
 * Validate the submitted values against the model's fields. Merge semantics:
 * an absent value means "untouched" and is skipped entirely. List entries
 * (arrays of records at the `[*]` path) are validated entry by entry with the
 * entry number attached to the problems.
 */
export function validateOptimisticValues(fields: readonly FormField[], values: FormValues): OptimisticLocalVerdict {
  const problems: OptimisticProblem[] = [];
  const visit = (scoped: readonly FormField[], scopeValues: FormValues): void => {
    for (const field of scoped) {
      const raw = scopeValues[field.path];
      if (raw === undefined) continue; // merge semantics: untouched
      const verdict = validateFormValue(field, raw);
      for (const error of verdict.errors) {
        problems.push({ path: field.path, code: error.code, message: error.message, pending: false });
      }
      for (const constraint of verdict.pending) {
        problems.push({ path: field.path, code: `pending.${constraint.kind}`, message: constraint.errorMessage ?? constraint.expression, pending: true });
      }
    }
    // List entries: records keyed by full child field paths (the form bridge's
    // contract); their subtree fields are visited per entry.
    const listPaths = new Set<string>();
    for (const field of scoped) {
      for (const step of field.path.slice(1).split("/")) {
        if (step.endsWith("[*]")) {
          const marker = field.path.indexOf(`/${step}`);
          listPaths.add(field.path.slice(0, marker + step.length + 1));
        }
      }
    }
    for (const listPath of listPaths) {
      const entries = scopeValues[listPath];
      if (!Array.isArray(entries)) continue;
      const childFields = scoped.filter(field => field.path.startsWith(`${listPath}/`));
      entries.forEach((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          problems.push({ path: listPath, code: "type.entry", message: `Entry ${index + 1} of '${listPath}' must be a record of field values.`, pending: false });
          return;
        }
        const before = problems.length;
        visit(childFields, entry as FormValues);
        for (let at = before; at < problems.length; at++) problems[at] = { ...problems[at]!, path: `${problems[at]!.path}[#${index + 1}]` };
      });
    }
  };
  visit(fields, values);
  const localStatus = problems.some(problem => !problem.pending) ? "invalid"
    : problems.length ? "indeterminate"
    : "valid";
  return { status: localStatus, problems };
}

/** Outcome of one submit — plain data throughout (§211's reconcile shape). */
export type OptimisticEditOutcome =
  | { kind: "blocked"; reason: "invalid" | "on-indeterminate" | "empty-body"; verdict: OptimisticLocalVerdict }
  | { kind: "done"; status: number; etag: string | undefined; verdict: OptimisticLocalVerdict }
  | { kind: "cancelled" }
  | { kind: "failed"; verdict: OptimisticLocalVerdict; server: OptimisticServerFailure };

export interface OptimisticServerFailure {
  message: string;
  name: string;
  httpStatus: number | undefined;
  errorType: string | undefined;
  errorTag: string | undefined;
  errorPath: string | undefined;
  errorMessages: readonly string[];
}

export interface OptimisticEditOptions {
  client: RestconfClient | undefined;
  /** The form model converts values to the RFC 7951 body (§195 contract). */
  model: FormModel;
  /** Target resource (module-qualified at the last step by the request builders). */
  resource: { module: string; name: string };
  /** RESTCONF path segments to the resource; default = the top-level resource itself. */
  path?: readonly { module: string; name: string }[] | undefined;
  /** PATCH (merge) by default; PUT replaces the whole resource (§8040 §4.5). */
  method?: "PATCH" | "PUT" | undefined;
  restconfRoot?: string | undefined;
  /**
   * `invalid` (default) and `empty-body` always block; `indeterminate` submits
   * with its pending reasons visible so the server stays the authority.
   */
  onIndeterminate?: "submit" | "block" | undefined;
}

/** Per-submit overrides (If-Match etag, extra headers, a signal). */
export interface OptimisticSubmitOptions {
  etag?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export type OptimisticEditState = {
  status: "idle" | "blocked" | "sending" | "done" | "failed";
  outcome: OptimisticEditOutcome | undefined;
};

export function useOptimisticEdit(options: OptimisticEditOptions) {
  const [state, setState] = useState<OptimisticEditState>({ status: "idle", outcome: undefined });

  const submit = useCallback(async (values: FormValues, submitOptions: OptimisticSubmitOptions = {}): Promise<OptimisticEditOutcome> => {
    const { client, model, resource, method = "PATCH", restconfRoot, onIndeterminate = "submit" } = options;
    const verdict = validateOptimisticValues(model.fields, values);
    if (verdict.status === "invalid") {
      const outcome: OptimisticEditOutcome = { kind: "blocked", reason: "invalid", verdict };
      setState({ status: "blocked", outcome });
      return outcome;
    }
    if (verdict.status === "indeterminate" && onIndeterminate === "block") {
      const outcome: OptimisticEditOutcome = { kind: "blocked", reason: "on-indeterminate", verdict };
      setState({ status: "blocked", outcome });
      return outcome;
    }
    if (!client) {
      const outcome: OptimisticEditOutcome = {
        kind: "failed", verdict,
        server: { message: "No RESTCONF client configured", name: "RestconfClientMissing", httpStatus: undefined, errorType: undefined, errorTag: undefined, errorPath: undefined, errorMessages: [] },
      };
      setState({ status: "failed", outcome });
      return outcome;
    }
    // The model's own body contract produces the RFC 7951 envelope.
    const envelope = formValuesToRestconfBody(model, values);
    const key = `${resource.module}:${resource.name}`;
    const data = envelope[key];
    // Merge semantics: an absent value means untouched, so an empty top-level
    // record carries no edit at all — sending it would only confuse the server.
    const emptyBody = data === undefined
      || (typeof data === "object" && data !== null && !Array.isArray(data) && Object.keys(data).length === 0);
    if (emptyBody) {
      // §211: never send an empty payload silently — the UI decides what to (re)target.
      const outcome: OptimisticEditOutcome = { kind: "blocked", reason: "empty-body", verdict };
      setState({ status: "blocked", outcome });
      return outcome;
    }
    const resourceData = data as RestconfResourceData;
    const path = options.path ?? [{ module: resource.module, name: resource.name }];
    const request: RestconfDataRequest = method === "PUT"
      ? createRestconfSetRequest(path, { module: resource.module, name: resource.name, data: resourceData }, restconfRoot)
      : createRestconfUpdateRequest(path, { module: resource.module, name: resource.name, data: resourceData }, restconfRoot);
    const sending: RestconfSendOptions = {
      ...(submitOptions.etag ? { headers: { "If-Match": submitOptions.etag } } : {}),
      ...(submitOptions.signal ? { signal: submitOptions.signal } : {}),
    };
    setState({ status: "sending", outcome: undefined });
    try {
      const response = await client.send(request, sending);
      const etag = response.headers.get("ETag") ?? undefined;
      const outcome: OptimisticEditOutcome = { kind: "done", status: response.status, etag, verdict };
      setState({ status: "done", outcome });
      return outcome;
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        const outcome: OptimisticEditOutcome = { kind: "cancelled" };
        setState({ status: "idle", outcome });
        return outcome;
      }
      const server: OptimisticServerFailure = {
        message: error instanceof Error ? error.message : String(error),
        name: (error as { name?: string }).name ?? "Error",
        httpStatus: (error as { status?: number }).status,
        errorType: (error as RestconfRequestError).errorType,
        errorTag: (error as RestconfRequestError).errorTag,
        errorPath: (error as RestconfRequestError).errorPath,
        errorMessages: (error as RestconfRequestError).errorMessages ?? [],
      };
      const outcome: OptimisticEditOutcome = { kind: "failed", verdict, server };
      setState({ status: "failed", outcome });
      return outcome;
    }
  }, [options]);

  return { ...state, submit };
}
