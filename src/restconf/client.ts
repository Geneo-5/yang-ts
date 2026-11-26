/**
 * §199–§203 — RESTCONF client: executes the requests the builders in
 * `paths.ts` produce through an injectable fetch. The library never touches a
 * global at import time: `fetchImpl` is required unless `globalThis.fetch`
 * already exists at the moment `createRestconfClient` is called.
 *
 * §200 (auth): static extra headers or a per-request header provider (bearer
 * tokens and the like live in the host application — prefer in-memory state;
 * cookie sessions via `credentials`).
 *
 * §201 (responses): success returns status + header lookup + lazy JSON;
 * `ietf-restconf:errors` bodies (RFC 8040 §7) map to `RestconfRequestError`
 * with the RFC fields kept verbatim; non-RESTCONF error bodies still yield a
 * typed error carrying the status. `ETag`/`Last-Modified`/`Location` reach
 * the caller through the header lookup so it can send `If-Match`/
 * `If-Unmodified-Since` (409/412 arrive as typed errors), and 204 yields an
 * undefined JSON body.
 */
import type { RestconfDataRequest, RestconfRpcRequest } from "./paths.js";

/** A request either builder produces (data CRUD/HEAD or RPC POST). */
export type RestconfExecutableRequest = RestconfDataRequest | RestconfRpcRequest;

/** Extra headers: static record or a per-request provider callback. */
export type RestconfHeaderSource =
  | Readonly<Record<string, string>>
  | ((request: { method: string; path: string }) =>
    | Readonly<Record<string, string>>
    | Promise<Readonly<Record<string, string>>>);

export interface RestconfClientOptions {
  /** Origin of the server, e.g. `https://host`; the request path provides `/restconf/…`. */
  baseUrl: string;
  /** Fetch implementation; required when `globalThis.fetch` is absent. */
  fetchImpl?: typeof fetch;
  /** Extra headers sent with every request (static record or provider). */
  headers?: RestconfHeaderSource;
  /** Cookie/session credentials forwarded to fetch (e.g. `include`). */
  credentials?: RequestCredentials;
  /** Base cancellation signal for every request of this client. */
  signal?: AbortSignal;
  /**
   * §203: retry policy. `attempts` is the total number of tries (1 = off,
   * the default) and applies to idempotent methods only (GET/HEAD), on
   * transport failures, per-call timeouts and 5xx responses; cancellation
   * and 4xx never retry. `backoffMs` doubles after each failed try.
   */
  retry?: RestconfRetryOptions;
}

export interface RestconfRetryOptions {
  /** Total tries; default 1 (no retry). */
  attempts?: number;
  /** Base wait between tries, doubling each time; default 0. */
  backoffMs?: number;
}

/** Minimal header lookup the caller uses for `Location`/`ETag`/`Last-Modified`. */
export interface RestconfClientResponse {
  readonly status: number;
  headers: { get(name: string): string | null };
  /** Parsed JSON body; `undefined` for 204 (and bodies the server left empty). */
  json(): Promise<unknown>;
}

/** Per-call sending overrides: conditional headers (`If-Match`, …), a signal replacing the base one, and a timeout (§203). */
export interface RestconfSendOptions {
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  /** Per-call request timeout in milliseconds; exceeding it rejects with a `TimeoutError` (and retries idempotent requests while attempts remain). */
  timeoutMs?: number;
}

export interface RestconfClient {
  /** Execute one builder-produced request through the injected fetch. */
  send(request: RestconfExecutableRequest, extras?: RestconfSendOptions): Promise<RestconfClientResponse>;
}

/**
 * §205: a request that never got an HTTP response (browser `TypeError` —
 * CORS, DNS, offline). Because browsers hide the status and headers of
 * blocked responses, the message carries the checklist hint instead of the
 * generic "Failed to fetch"; the original error stays reachable as `cause`.
 */
export class RestconfNetworkError extends Error {
  constructor(cause: unknown) {
    super(
      "RESTCONF request failed without an HTTP response — the browser hides the real status. " +
      "Check CORS: the server must send Access-Control-Allow-Origin for this origin, list the " +
      "method and the Accept/Content-Type headers in Access-Control-Allow-Methods/-Headers, and " +
      "answer any OPTIONS preflight; also verify the URL and the network.",
    );
    this.name = "RestconfNetworkError";
    this.cause = cause;
  }
}

/**
 * A request that failed (non-2xx). When the body carried an RFC 8040 §7
 * `ietf-restconf:errors` payload, the first error entry's fields populate
 * `errorType`/`errorTag`/`errorPath` and `errorMessages` lists every entry's
 * message; other bodies keep only the status and the raw complaint.
 */
export class RestconfRequestError extends Error {
  readonly status: number;
  readonly errorType: string | undefined;
  readonly errorTag: string | undefined;
  readonly errorPath: string | undefined;
  readonly errorMessages: readonly string[];

  constructor(
    status: number,
    message: string,
    details: {
      errorType?: string | undefined;
      errorTag?: string | undefined;
      errorPath?: string | undefined;
      errorMessages?: readonly string[] | undefined;
    } = {},
  ) {
    super(message);
    this.name = "RestconfRequestError";
    this.status = status;
    this.errorType = details.errorType;
    this.errorTag = details.errorTag;
    this.errorPath = details.errorPath;
    this.errorMessages = details.errorMessages ?? [];
  }
}

interface RawRpcError {
  "error-type"?: unknown;
  "error-tag"?: unknown;
  "error-path"?: unknown;
  "error-message"?: unknown;
}

const textOf = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as Record<string, unknown>)["#text"] === "string") {
    return (value as Record<string, string>)["#text"];
  }
  return undefined;
};

const ERROR_KEYS = ["ietf-restconf:errors", "errors"];
const errorPlaceholders: readonly string[] = [];

async function typedError(response: { status: number; statusText: string }, body: unknown): Promise<RestconfRequestError> {
  const payload = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  const wrapper = payload ? ERROR_KEYS.map(key => payload[key]).find(entry => entry && typeof entry === "object") as Record<string, unknown> | undefined : undefined;
  const list = wrapper && Array.isArray(wrapper.error) ? wrapper.error as RawRpcError[] : [];
  const first = list[0];
  if (!first) {
    return new RestconfRequestError(response.status, `RESTCONF request failed with ${response.status} ${response.statusText}`);
  }
  const messages = list
    .map(entry => textOf(entry["error-message"]))
    .filter((message): message is string => message !== undefined && message !== "");
  return new RestconfRequestError(response.status, `RESTCONF request failed with ${response.status} (${textOf(first["error-tag"]) ?? response.statusText})`, {
    errorType: textOf(first["error-type"]),
    errorTag: textOf(first["error-tag"]),
    errorPath: textOf(first["error-path"]),
    ...(messages.length > 0 ? { errorMessages: messages } : { errorMessages: errorPlaceholders }),
  });
}

/**
 * Create the client. `baseUrl` is the server origin (or any base the
 * request-builder paths attach to); a request `path` must be usable as a
 * root-relative suffix.
 */
export function createRestconfClient(options: RestconfClientOptions): RestconfClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) throw new Error("No fetch implementation available: pass fetchImpl in RestconfClientOptions");
  const base = options.baseUrl.replace(/\/+$/, "");
  const closure = options.signal;
  const headerSource = options.headers;
  const retryAttempts = Math.max(1, options.retry?.attempts ?? 1);
  const retryBackoff = Math.max(0, options.retry?.backoffMs ?? 0);
  const wait = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

  return {
    async send(request: RestconfExecutableRequest, extras: RestconfSendOptions = {}): Promise<RestconfClientResponse> {
      const idempotent = request.method === "GET" || request.method === "HEAD";
      const maxAttempts = idempotent ? retryAttempts : 1;
      const finishSignal = extras.signal ?? closure;
      const extra = typeof headerSource === "function"
        ? await headerSource({ method: request.method, path: request.path })
        : headerSource;
      const headers = { ...request.headers, ...(extra ?? {}), ...extras.headers };
      const url = `${base}${request.path}`;

      let attempt = 1;
      for (;;) {
        let timedOut = false;
        let timeoutController: AbortController | undefined;
        let forwardCallerAbort: (() => void) | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          let signal = finishSignal;
          if (extras.timeoutMs !== undefined) {
            timeoutController = new AbortController();
            if (finishSignal) {
              forwardCallerAbort = () => timeoutController!.abort(finishSignal.reason);
              finishSignal.addEventListener("abort", forwardCallerAbort, { once: true });
            }
            signal = timeoutController.signal;
            timer = setTimeout(() => {
              timedOut = true;
              timeoutController!.abort(new DOMException("The RESTCONF request timed out.", "TimeoutError"));
            }, extras.timeoutMs);
          }
          const response = await fetchImpl(url, {
            method: request.method,
            headers,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
            ...(options.credentials ? { credentials: options.credentials } : {}),
            ...(signal ? { signal } : {}),
          });
          // §203: idempotent 5xx calls retry while attempts remain.
          if (idempotent && response.status >= 500 && attempt < maxAttempts) {
            await wait(retryBackoff * 2 ** (attempt - 1));
            attempt++;
            continue;
          }
          if (response.status === 204) {
            return { status: 204, headers: response.headers, json: async () => undefined };
          }
          if (response.ok) {
            return { status: response.status, headers: response.headers, json: () => response.json() };
          }
          let body: unknown;
          try {
            body = await response.json();
          } catch {
            body = undefined;
          }
          throw await typedError(response, body);
        } catch (error) {
          if (error instanceof RestconfRequestError) throw error; // final: a server answer, never retried
          // Cancellation wins over every other classification, including CORS.
          if (finishSignal?.aborted) throw finishSignal.reason ?? error;
          if (timedOut || error instanceof TypeError) {
            // Transport-class failure (timeout or no HTTP response): a timed-out
            // or idempotent request may retry while attempts remain; a POST/PUT
            // never does. Attempts spent, TypeError turns into the §205 hint.
            if (idempotent && attempt < maxAttempts) {
              await wait(retryBackoff * 2 ** (attempt - 1));
              attempt++;
              continue;
            }
            if (error instanceof TypeError) throw new RestconfNetworkError(error);
            throw error;
          }
          throw error;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          if (forwardCallerAbort && finishSignal) finishSignal.removeEventListener("abort", forwardCallerAbort);
        }
      }
    },
  };
}
