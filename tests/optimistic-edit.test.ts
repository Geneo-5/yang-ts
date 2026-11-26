// @vitest-environment jsdom
/**
 * §211 — optimistic edit flow: edit → local validation (valid/invalid/
 * indeterminate with reasons) → PATCH/PUT → reconcile with server errors.
 *
 * The hard rules:
 * - an INVALID local value never reaches the wire (blocked, reasons exposed);
 * - an INDETERMINATE value is NOT silently blocked — it submits and the
 *   pending reasons stay visible (the server is the authority); an explicit
 *   policy may choose to block instead;
 * - server failures surface the RFC 8040 §7 fields (errorTag, errorPath,
 *   errorMessages) through the client's RestconfRequestError.
 */
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createElement, type ReactElement } from "react";
import { compileYangModules, parseYang, resolveModuleSet, createFormModel } from "../src/index.js";
import { useOptimisticEdit, validateOptimisticValues } from "../src/react/index.js";
import { RestconfRequestError } from "../src/restconf/client.js";
import type { RestconfClient, RestconfClientResponse } from "../src/restconf/client.js";
import type { RestconfDataRequest } from "../src/restconf/paths.js";
import type { FormModel } from "../src/forms/form-model.js";
import type { FormValues } from "../src/forms/restconf-body.js";

async function compileModel(): Promise<FormModel> {
  const schema = compileYangModules(
    await resolveModuleSet([parseYang(`module conf { namespace "urn:conf"; prefix c;
      container relay {
        leaf level { type uint8 { range "1..5"; } }
        leaf mode { type enumeration { enum on; enum off; } }
      } }`)], { async loadModule() { return undefined; } }),
  );
  return createFormModel(schema, { module: "conf" });
}

describe("local verdict (§211)", () => {
  it("tells valid, invalid and indeterminate apart with reasons", async () => {
    const model = await compileModel();
    const ok = validateOptimisticValues(model.fields, { "/relay/level": "3", "/relay/mode": "on" });
    expect(ok.status).toBe("valid");
    expect(ok.problems).toEqual([]);

    const bad = validateOptimisticValues(model.fields, { "/relay/level": "9", "/relay/mode": "on" });
    expect(bad.status).toBe("invalid");
    expect(bad.problems.map(problem => ({ ...problem, message: undefined }))).toEqual([
      { path: "/relay/level", code: "constraint.range", pending: false, message: undefined },
    ]);

    // A must/when the engine cannot evaluate here stays a VISIBLE reason, not silence.
    const evaluated = validateOptimisticValues(model.fields, { "/relay/level": "3" });
    expect(evaluated.status).toBe("valid"); // mode absent: a merge edit skips it

    const unknown = validateOptimisticValues(model.fields, { "/relay/mode": "solar" });
    expect(unknown.status).toBe("invalid");
    expect(unknown.problems[0]!.code).toBe("type.enum");
    // absent = untouched (merge semantics): never a required-error here.
    expect(validateOptimisticValues(model.fields, {}).problems).toEqual([]);
  });

  it("surfaces indeterminate as pending problems with the constraint expression", async () => {
    const schema = compileYangModules(
      await resolveModuleSet([parseYang(`module pend { namespace "urn:pend"; prefix p;
        leaf mode { type string; must "count(*) > 0"; }
      }`)], { async loadModule() { return undefined; } }),
    );
    const model = createFormModel(schema, { module: "pend" });
    const verdict = validateOptimisticValues(model.fields, { "/mode": "x" });
    expect(verdict.status).toBe("indeterminate");
    expect(verdict.problems.map(problem => problem.code)).toContain("pending.must");
    expect(verdict.problems.map(problem => problem.path)).toEqual(["/mode"]);
  });
});

describe("useOptimisticEdit (§211)", () => {
  const response = (status: number, headers: Record<string, string> = {}): RestconfClientResponse => ({
    status, headers: { get: name => headers[name] ?? null }, json: () => Promise.resolve(undefined),
  });

  function mountHook(model: FormModel, options: Omit<Parameters<typeof useOptimisticEdit>[0], "model">) {
    const states: ReturnType<typeof useOptimisticEdit>[] = [];
    const Probe = (): ReactElement | null => {
      states.push(useOptimisticEdit({ model, ...options }));
      return createElement("div");
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => { root.render(createElement(Probe)); });
    return {
      last: () => states[states.length - 1]!,
      unmount() { act(() => { root.unmount(); }); container.remove(); },
    };
  }

  const base = {
    resource: { module: "conf", name: "relay" },
    path: [{ module: "conf", name: "relay" }],
  };

  it("invalid values are blocked BEFORE the wire; indeterminate values submit with visible reasons", async () => {
    const send = vi.fn().mockResolvedValue(response(204));
    const client = { send } as unknown as RestconfClient;
    const model = await compileModel();
    const view = mountHook(model, { client, ...base });
    const edit = view.last();

    await act(async () => {
      const outcome = await edit.submit({ "/relay/level": "9" });
      expect(outcome.kind).toBe("blocked");
    });
    expect(send).not.toHaveBeenCalled();
    expect(view.last().status).toBe("blocked");

    // indeterminate submits (never silently blocks) with pending reasons visible.
    const pendingModel = createFormModel(compileYangModules(
      await resolveModuleSet([parseYang(`module pend { namespace "urn:pend"; prefix p;
        leaf mode { type string; must "count(*) > 0"; }
      }`)], { async loadModule() { return undefined; } }),
    ), { module: "pend" });
    const pendingView = mountHook(pendingModel, {
      client, resource: { module: "pend", name: "mode" }, path: [{ module: "pend", name: "mode" }],
    });
    await act(async () => {
      const outcome = await pendingView.last().submit({ "/mode": "x" });
      expect(outcome.kind).toBe("done");
      expect((outcome as { verdict: { status: string } }).verdict.status).toBe("indeterminate");
    });
    expect(send).toHaveBeenCalledTimes(1);
    view.unmount();
    pendingView.unmount();
  });

  it("sends a PATCH by default, PUT on demand, with body from the model contract and If-Match", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(response(200, { ETag: '"w1"' }))
      .mockResolvedValueOnce(response(204));
    const client = { send } as unknown as RestconfClient;
    const model = await compileModel();
    const view = mountHook(model, { client, ...base });
    await act(async () => {
      const outcome = await view.last().submit({ "/relay/level": "3", "/relay/mode": "on" });
      expect(outcome.kind).toBe("done");
      expect((outcome as { etag?: string }).etag).toBe('"w1"');
    });
    const request = send.mock.calls[0]![0] as RestconfDataRequest;
    expect(request.method).toBe("PATCH");
    expect(request.headers["Content-Type"]).toBe("application/yang-data+json");
    expect(request.body).toEqual({ "conf:relay": { level: 3, mode: "on" } });

    const putView = mountHook(model, { client, ...base, method: "PUT" as const });
    await act(async () => {
      await putView.last().submit({ "/relay/level": "2" }, { etag: '"w0"' });
    });
    const put = send.mock.calls[1]![0] as RestconfDataRequest;
    expect(put.method).toBe("PUT");
    expect(send.mock.calls[1]![1]!.headers).toEqual({ "If-Match": '"w0"' });
    view.unmount();
    putView.unmount();
  });

  it("reconciles RFC 8040 §7 server errors with the client's error fields", async () => {
    const failure = new RestconfRequestError(422, "PATCH rejected", {
      errorType: "application",
      errorTag: "invalid-value",
      errorPath: "/conf:relay/c:level",
      errorMessages: ["too hot"],
    });
    const send = vi.fn().mockRejectedValue(failure);
    const client = { send } as unknown as RestconfClient;
    const model = await compileModel();
    const view = mountHook(model, { client, ...base });
    await act(async () => {
      const outcome = await view.last().submit({ "/relay/level": "4" });
      expect(outcome.kind).toBe("failed");
      const server = (outcome as { server: { errorTag?: string; errorMessages?: readonly string[]; errorPath?: string; httpStatus?: number } }).server;
      expect(server.errorTag).toBe("invalid-value");
      expect(server.errorPath).toBe("/conf:relay/c:level");
      expect(server.errorMessages).toEqual(["too hot"]);
      expect(server.httpStatus).toBe(422);
    });
    expect(view.last().status).toBe("failed");
    view.unmount();
  });

  it("blocks an empty body loudly instead of sending nothing", async () => {
    const send = vi.fn();
    const client = { send } as unknown as RestconfClient;
    const model = await compileModel();
    const view = mountHook(model, { client, ...base });
    await act(async () => {
      const outcome = await view.last().submit({});
      expect(outcome).toMatchObject({ kind: "blocked", reason: "empty-body" });
    });
    expect(send).not.toHaveBeenCalled();
    view.unmount();
  });
});
