// @vitest-environment jsdom
/**
 * §208 — headless React hooks (YangProvider, useYangSchema, useFormModel,
 * useFieldValidation, useDataValidation, useCandidates, useRestconfResource).
 * Also covers §209's contract: initialization in an effect, loading-first
 * render, hydration without mismatch, strict-mode safety.
 */
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createElement, StrictMode, type ReactElement } from "react";
import { parseXml } from "./dom.js";
import { compileYangModules, parseYang, resolveModuleSet } from "../src/index.js";
import {
  YangProvider, useYangSchema, useFormModel, useFieldValidation, useDataValidation,
  useCandidates, useRestconfResource,
} from "../src/react/index.js";
import type { CompiledYangSchema } from "../src/yang/compiler.js";
import type { RestconfClient } from "../src/restconf/client.js";
import type { FormValidationResult } from "../src/forms/form-model.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SCHEMA_SOURCE = `module probe {
  namespace "urn:probe"; prefix p;
  choice mode {
    case fast { leaf speed { type uint8; } }
    case slow { leaf retry { type uint8; } }
  }
  leaf enabled { type boolean; }
  leaf level { type enumeration { enum low; enum high; } }
}`;

async function compileProbe(): Promise<CompiledYangSchema> {
  return compileYangModules(
    await resolveModuleSet([parseYang(SCHEMA_SOURCE)], { async loadModule() { return undefined; } }),
  );
}

/** Mount one probe that appends a hook's value to `states` on every render. */
function probeOf(hook: (index: number) => unknown, count = 1) {
  const states: unknown[][] = [];
  const Probe = (): ReactElement => {
    const values: unknown[] = [];
    for (let index = 0; index < count; index++) values.push(hook(index));
    states.push(values);
    return createElement("div");
  };
  return {
    states, Probe,
    last: () => states[states.length - 1]!,
  };
}

function mount(element: ReactElement) {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => { root.render(element); });
  return {
    unmount() { act(() => { root.unmount(); }); },
  };
}

function flush() { return act(async () => { await Promise.resolve(); }); }

describe("YangProvider / useYangSchema (§208, §209)", () => {
  it("exposes an already-compiled schema from the first render (hydration-safe, §209)", async () => {
    const schema = await compileProbe();
    const probe = probeOf(() => useYangSchema());
    // Outside the provider the hook reports an explicit error; inside it is ready.
    const view = mount(createElement(YangProvider, { schema }, createElement(probe.Probe)));
    expect(probe.last()[0]).toMatchObject({ status: "ready" });
    view.unmount();
  });

  it("starts loading, compiles in an effect (§209) and reports errors as text", async () => {
    const probe = probeOf(() => useYangSchema());
    const view = mount(createElement(YangProvider, { compile: compileProbe }, createElement(probe.Probe)));
    expect(probe.states[0]).toEqual([{ status: "loading" }]);
    await flush();
    expect(probe.last()[0]).toMatchObject({ status: "ready" });
    view.unmount();

    const failure = probeOf(() => useYangSchema());
    const failureView = mount(createElement(YangProvider, { compile: () => Promise.reject(new Error("boom")) }, createElement(failure.Probe)));
    expect(failure.states[0]).toEqual([{ status: "loading" }]);
    await flush();
    expect(failure.last()[0]).toEqual({ status: "error", error: "boom" });
    failureView.unmount();
  });

  it("reports an explicit error state outside a provider", () => {
    const probe = probeOf(() => useYangSchema());
    const view = mount(createElement(probe.Probe));
    expect(probe.last()[0]).toEqual({ status: "error", error: "useYangSchema requires a <YangProvider> ancestor" });
    view.unmount();
  });

  it("is safe under React StrictMode double-effects (§208)", async () => {
    const compile = vi.fn(compileProbe);
    const probe = probeOf(() => useYangSchema());
    const view = mount(createElement(StrictMode, null, createElement(YangProvider, { compile }, createElement(probe.Probe))));
    await flush();
    expect(probe.last()[0]).toMatchObject({ status: "ready" });
    expect(compile.mock.calls.length).toBeLessThanOrEqual(2);
    view.unmount();
  });
});

describe("form hooks (§208)", () => {
  it("useFormModel returns undefined while loading, metadata once ready", async () => {
    const probe = probeOf(() => useFormModel());
    const view = mount(createElement(YangProvider, { compile: compileProbe }, createElement(probe.Probe)));
    expect(probe.states[0]).toEqual([undefined]);
    await flush();
    const model = probe.last()[0] as { fields: { path: string }[] };
    expect(model.fields.map(field => field.path).sort()).toEqual(["/enabled", "/level", "/retry", "/speed"]);
    view.unmount();
  });

  it("useFieldValidation validates against the model's field", async () => {
    let field: Parameters<typeof useFieldValidation>[0] | undefined;
    const probe = probeOf(() => {
      const model = useFormModel();
      field = model?.fields.find(candidate => candidate.path === "/level");
      return [useFieldValidation(field, "low"), useFieldValidation(field, "medium")];
    }, 1);
    const view = mount(createElement(YangProvider, { schema: await compileProbe() }, createElement(probe.Probe)));
    const [valid, invalid] = probe.last()[0] as unknown as [FormValidationResult, FormValidationResult];
    expect(valid.status).toBe("valid");
    expect(invalid.status).toBe("invalid");
    expect(invalid.errors[0]?.code).toBe("type.enum");
    view.unmount();
  });

  it("useDataValidation and useCandidates stay undefined without an instance (then validate a real one)", async () => {
    const schema = await compileProbe();
    const instance = parseXml(`<source-level xmlns="urn:probe"><enabled>true</enabled><level>low</level></source-level>`);
    const probe = probeOf(() => [useDataValidation(undefined), useCandidates(undefined, "/level")]);
    const view = mount(createElement(YangProvider, { schema }, createElement(probe.Probe)));
    expect(probe.last()[0]).toEqual([undefined, undefined]);
    view.unmount();

    const real = probeOf(() => [useDataValidation(instance), useCandidates(instance, "/level")]);
    const realView = mount(createElement(YangProvider, { schema }, createElement(real.Probe)));
    const [validation, candidates] = real.last()[0] as unknown as [
      { status: string; issues: unknown[] },
      { path: string; domain: string; candidates: { value: string; status: string }[] },
    ];
    expect(validation.status).toBe("valid");
    expect(candidates.path).toBe("/level");
    expect(candidates.candidates.map(candidate => candidate.value).sort()).toEqual(["high", "low"]);
    realView.unmount();
  });
});

describe("useRestconfResource (§208)", () => {
  const fakeResponse = (status: number, body: unknown) => ({ status, headers: { get: () => null }, json: () => Promise.resolve(body) });

  it("loads data, reports errors as text, refetches and aborts on unmount", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(fakeResponse(200, { "probe:enabled": true }))
      .mockRejectedValueOnce(Object.assign(new Error("500 upstream"), { status: 500 }))
      .mockResolvedValueOnce(fakeResponse(200, { "probe:enabled": false }));
    const client = { send } as unknown as RestconfClient;
    const probe = probeOf(() => useRestconfResource(client, [], { resource: { module: "probe", name: "enabled" } }));
    const view = mount(createElement(probe.Probe));
    expect(probe.last()[0]).toMatchObject({ status: "loading", data: undefined });

    // First GET lands: plain data, ready.
    await flush();
    expect(probe.last()[0]).toMatchObject({ status: "ready", data: true });
    // The request went through the GET builder path for a top resource.
    expect(send.mock.calls[0]![0].method).toBe("GET");

    // refetch fails once → error state as TEXT (serializable), then succeeds.
    const { refetch } = probe.last()[0] as { refetch: () => void };
    await act(async () => { refetch(); await flush(); });
    const errored = probe.last()[0] as { status: string; error: string | undefined; httpStatus: number | undefined };
    expect(errored.status).toBe("error");
    expect(errored.error).toBe("500 upstream");
    expect(errored.httpStatus).toBe(500);

    await act(async () => { refetch(); await flush(); });
    expect(probe.last()[0]).toMatchObject({ status: "ready", data: false });

    // No dangling mounts, no unhandled rejections at teardown.
    view.unmount();
  });

  it("reports transport failures without an http status", async () => {
    const send = vi.fn().mockRejectedValue(new Error("Failed to fetch"));
    const client = { send } as unknown as RestconfClient;
    const probe = probeOf(() => useRestconfResource(client, []));
    const view = mount(createElement(probe.Probe));
    await flush();
    expect(probe.last()[0]).toMatchObject({
      status: "error", error: "Failed to fetch", httpStatus: undefined,
    });
    view.unmount();
  });
});
