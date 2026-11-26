import { describe, expect, it } from "vitest";
import {
  createRestconfAddRequest,
  createRestconfClient,
  createRestconfGetRequest,
  createRestconfDeleteRequest,
  createRestconfNmdaProbeRequest,
  createRestconfRpcRequest,
  createRestconfSetRequest,
} from "../src/index.js";
import type { RestconfRequestError } from "../src/index.js";
import type { RestconfDataRequest } from "../src/index.js";
import type { YangPathSegment } from "../src/index.js";

interface RecordedCall {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
}

const STUB_URL = "https://host/restconf/data/probe:top/items=first";

const stubFetch = (status: number, body: unknown = undefined, headers: Record<string, string> = {}) => {
  const calls: RecordedCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: typeof input === "string" ? input : String(input),
      init: { ...(init ?? {}), headers: (init?.headers ?? {}) as Record<string, string> },
    });
    const response = {
      ok: status >= 200 && status < 300,
      status,
      statusText: "stub",
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => body,
      text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)),
    };
    return response as unknown as Response;
  };
  return { calls, impl: impl as unknown as typeof fetch };
};

const PATH: YangPathSegment[] = [
  { name: "top", module: "probe" },
  { name: "items", module: "probe", keys: [{ name: "k", value: "first" }] },
];

describe("createRestconfClient (§199)", () => {
  it("joins the request path onto the base URL and executes with the builder's method", async () => {
    const { calls, impl } = stubFetch(200, { "probe:top": { i8: 7 } });
    const client = createRestconfClient({ baseUrl: "https://host", fetchImpl: impl });
    const response = await client.send(createRestconfGetRequest(PATH, "/restconf", { depth: "1" }));
    expect(calls[0]!.url).toBe(`${STUB_URL}?depth=1`);
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.headers["Accept"]).toBe("application/yang-data+json");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ "probe:top": { i8: 7 } });
  });

  it("sends edit bodies with their content type and returns status plus headers", async () => {
    const { calls, impl } = stubFetch(201, undefined, { location: "/restconf/data/probe:top/items=second" });
    const client = createRestconfClient({ baseUrl: "https://host", fetchImpl: impl });
    const response = await client.send(createRestconfAddRequest(
      [{ name: "top", module: "probe" }],
      { module: "probe", name: "items", data: { k: "second" } },
    ));
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers["Content-Type"]).toBe("application/yang-data+json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ "probe:items": { k: "second" } });
    expect(response.status).toBe(201);
    expect(response.headers.get("Location")).toBe("/restconf/data/probe:top/items=second");
    await client.send(createRestconfDeleteRequest(PATH));
    await client.send(createRestconfSetRequest(PATH, { module: "probe", name: "items", data: { k: "first", v: 2 } }));
    await client.send(createRestconfNmdaProbeRequest());
    expect(calls.map(call => call.init.method)).toEqual(["POST", "DELETE", "PUT", "HEAD"]);
    const putBody = JSON.parse(calls[2]!.init.body as string) as Record<string, unknown>;
    expect(Object.keys(putBody)).toEqual(["probe:items"]);
  });

  it("maps ietf-restconf:errors payloads to a typed RestconfRequestError", async () => {
    const { impl } = stubFetch(409, {
      "ietf-restconf:errors": {
        error: [{
          "error-type": "protocol",
          "error-tag": "data-exists",
          "error-path": "/restconf/data/probe:top/items=first",
          "error-message": "Data already exists",
        }],
      },
    });
    const client = createRestconfClient({ baseUrl: "https://host", fetchImpl: impl });
    const error = await client.send(createRestconfAddRequest(
      [{ name: "top", module: "probe" }],
      { module: "probe", name: "items", data: { k: "first" } },
    )).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    const typed = error as RestconfRequestError;
    expect(typed.name).toBe("RestconfRequestError");
    expect(typed.status).toBe(409);
    expect(typed.errorTag).toBe("data-exists");
    expect(typed.errorType).toBe("protocol");
    expect(typed.errorPath).toBe("/restconf/data/probe:top/items=first");
    expect(typed.errorMessages).toEqual(["Data already exists"]);
  });

  it("keeps a non-RESTCONF error body inspectable and still typed", async () => {
    const { impl } = stubFetch(503, "NOT-JSON");
    const client = createRestconfClient({ baseUrl: "https://host", fetchImpl: impl });
    const error = await client.send(createRestconfGetRequest(PATH)).then(
      () => undefined,
      (failure: unknown) => failure as RestconfRequestError,
    );
    expect((error as Error).name).toBe("RestconfRequestError");
    expect(error!.status).toBe(503);
    expect(error!.errorTag).toBeUndefined();
    expect(String(error!.message)).toContain("503");
  });

  it("returns undefined for 204 without a body", async () => {
    const { impl } = stubFetch(204);
    const client = createRestconfClient({ baseUrl: "https://host", fetchImpl: impl });
    const response = await client.send(createRestconfDeleteRequest(PATH));
    expect(response.status).toBe(204);
    expect(await response.json()).toBeUndefined();
  });

  it("merges static headers and asks the header provider per request", async () => {
    const asked: string[] = [];
    const { calls, impl } = stubFetch(200);
    const client = createRestconfClient({
      baseUrl: "https://host",
      fetchImpl: impl,
      headers: { "X-Static": "s" },
    });
    const authClient = createRestconfClient({
      baseUrl: "https://host",
      fetchImpl: impl,
      headers: ({ method, path }) => {
        asked.push(method);
        void path;
        return { Authorization: `Bearer ${method === "GET" ? "read" : "write"}` };
      },
      credentials: "include",
    });
    await client.send(createRestconfGetRequest(PATH));
    await authClient.send(createRestconfGetRequest(PATH));
    expect(calls[0]!.init.headers["X-Static"]).toBe("s");
    expect(calls[1]!.init.headers["Authorization"]).toBe("Bearer read");
    expect(asked).toEqual(["GET"]);
    expect(calls[1]!.init.credentials).toBe("include");
  });

  it("forwards its base signal so host cancellation reaches fetch", async () => {
    const { calls, impl } = stubFetch(200);
    const controller = new AbortController();
    const client = createRestconfClient({ baseUrl: "https://host", fetchImpl: impl, signal: controller.signal });
    await client.send(createRestconfGetRequest(PATH));
    expect((calls[0]!.init.signal as AbortSignal).aborted).toBe(false);
    controller.abort();
    expect((calls[0]!.init.signal as AbortSignal).aborted).toBe(true);
  });

  it("takes per-call conditional headers (If-Match) and a replacing signal", async () => {
    const { calls, impl } = stubFetch(200);
    const controller = new AbortController();
    const perCall = new AbortController();
    const client = createRestconfClient({
      baseUrl: "https://host",
      fetchImpl: impl,
      signal: controller.signal,
      headers: { "X-Static": "s" },
    });
    await client.send(createRestconfSetRequest(
      PATH,
      { module: "probe", name: "items", data: { k: "first", v: 3 } },
      "/restconf",
    ), { headers: { "If-Match": "W/\"v2\"" }, signal: perCall.signal });
    const init = calls[0]!.init;
    expect(init.headers["Accept"]).toBe("application/yang-data+json");
    expect(init.headers["X-Static"]).toBe("s");
    expect(init.headers["If-Match"]).toBe('W/"v2"');
    expect((init.signal as AbortSignal).aborted).toBe(false);
    controller.abort();
    expect((init.signal as AbortSignal).aborted).toBe(false); // le signal d'appel a remplacé le signal de base
  });

  it("walks a list depth-first with the query parameter and probes NMDA (§202)", async () => {
    const { calls, impl } = stubFetch(200, { "probe:top": { items: [{ k: "first" }, { k: "second" }] } });
    const client = createRestconfClient({ baseUrl: "https://host", fetchImpl: impl });
    const top = await client.send(createRestconfGetRequest([{ name: "top", module: "probe" }], "/restconf", { depth: 1 }));
    await top.json();
    const entryReads = ([{ k: "first" }, { k: "second" }] as const).map(entry =>
      createRestconfGetRequest(
        [
          { name: "top", module: "probe" },
          { name: "items", module: "probe", keys: [{ name: "k", value: entry.k }] },
        ],
        "/restconf",
        { content: "config" },
      ));
    for (const read of entryReads) await client.send(read);
    await client.send(createRestconfNmdaProbeRequest());
    expect(calls.map(call => call.url)).toEqual([
      "https://host/restconf/data/probe:top?depth=1",
      "https://host/restconf/data/probe:top/items=first?content=config",
      "https://host/restconf/data/probe:top/items=second?content=config",
      "https://host/restconf/ds/ietf-datastores:operational",
    ]);
    expect(calls[3]!.init.method).toBe("HEAD");
  });

  it("retries idempotent methods on transport failure and 5xx (§203)", async () => {
    let calls = 0;
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls++;
      if (calls === 1) throw new TypeError("network hiccup");
      if (calls === 2) return { ok: false, status: 503, statusText: "unavailable", headers: { get: () => null }, json: async () => undefined } as unknown as Response;
      return { ok: true, status: 200, statusText: "ok", headers: { get: () => null }, json: async () => ({ up: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = createRestconfClient({ baseUrl: "https://host", fetchImpl: flaky, retry: { attempts: 3, backoffMs: 1 } });
    const response = await client.send(createRestconfGetRequest(PATH));
    expect(calls).toBe(3);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ up: true });
  });

  it("never retries non-idempotent methods (§203)", async () => {
    let calls = 0;
    const failing = (async (): Promise<Response> => { calls++; throw new TypeError("nope"); }) as unknown as typeof fetch;
    const client = createRestconfClient({ baseUrl: "https://host", fetchImpl: failing, retry: { attempts: 3, backoffMs: 1 } });
    // POST is never retried, but its CORS-style transport failure still gets the diagnostic hint (§205).
    const failure = await client.send(createRestconfAddRequest(
      [{ name: "top", module: "probe" }],
      { module: "probe", name: "items", data: { k: "n" } },
    )).then(() => undefined, (cause: unknown) => cause as Error);
    expect(failure!.name).toBe("RestconfNetworkError");
    expect(calls).toBe(1);
  });

  it("stops retrying when the attempts are spent and surfaces the typed error (§203)", async () => {
    let calls = 0;
    const failing = (async (): Promise<Response> => {
      calls++;
      return { ok: false, status: 503, statusText: "unavailable", headers: { get: () => null }, json: async () => ({ "ietf-restconf:errors": { error: [{ "error-tag": "operation-failed" }] } }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = createRestconfClient({ baseUrl: "https://host", fetchImpl: failing, retry: { attempts: 2, backoffMs: 1 } });
    const error = await client.send(createRestconfGetRequest(PATH)).then(() => undefined, (failure: unknown) => failure as RestconfRequestError);
    expect(calls).toBe(2);
    expect((error as Error).name).toBe("RestconfRequestError");
    expect(error!.errorTag).toBe("operation-failed");
  });

  it("does not retry 4xx responses (§203)", async () => {
    let calls = 0;
    const failing = (async (): Promise<Response> => {
      calls++;
      return { ok: false, status: 404, statusText: "missing", headers: { get: () => null }, json: async () => undefined } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = createRestconfClient({ baseUrl: "https://host", fetchImpl: failing, retry: { attempts: 3, backoffMs: 1 } });
    await expect(client.send(createRestconfGetRequest(PATH))).rejects.toMatchObject({ name: "RestconfRequestError" });
    expect(calls).toBe(1);
  });

  it("applies the per-call timeout and rejects with the timeout reason (§203)", async () => {
    const never = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    const client = createRestconfClient({ baseUrl: "https://host", fetchImpl: never, retry: { attempts: 2, backoffMs: 1 } });
    const failure = await client.send(createRestconfGetRequest(PATH), { timeoutMs: 20 }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect((failure as Error).name).toBe("TimeoutError");
  });

  it("does not retry when the caller cancels (§203)", async () => {
    let calls = 0;
    const hangThenFail = (async (): Promise<Response> => { calls++; throw new TypeError("network down"); }) as unknown as typeof fetch;
    const controller = new AbortController();
    const client = createRestconfClient({ baseUrl: "https://host", fetchImpl: hangThenFail, retry: { attempts: 4, backoffMs: 5_000 } });
    const pending = client.send(createRestconfGetRequest(PATH), { signal: controller.signal });
    controller.abort();
    const failure = await pending.then(() => undefined, (cause: unknown) => cause);
    expect((failure as Error).name).toBe("AbortError");
    expect(calls).toBe(1); // pas de tentative supplémentaire après une annulation
  });

  it("wraps CORS-style transport failures with a diagnostic hint (§205)", async () => {
    const cors = (async (): Promise<Response> => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    const client = createRestconfClient({ baseUrl: "https://host", fetchImpl: cors });
    const failure = await client.send(createRestconfGetRequest(PATH)).then(() => undefined, (cause: unknown) => cause);
    expect((failure as Error).name).toBe("RestconfNetworkError");
    expect(String((failure as Error).message)).toMatch(/Access-Control-Allow-Origin/i);
    expect(String((failure as Error).message)).toMatch(/OPTIONS/);
  });

  it("refuses to build without a fetch implementation (no global access at import time)", () => {
    const holder = globalThis as { fetch?: typeof fetch | undefined };
    const globalFetch = holder.fetch;
    holder.fetch = undefined;
    try {
      expect(() => createRestconfClient({ baseUrl: "https://host" })).toThrowError(/fetchImpl/);
    } finally {
      holder.fetch = globalFetch;
    }
  });
});
