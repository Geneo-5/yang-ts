/**
 * §204 — RESTCONF notification streams over EventSource (RFC 8040 §6). The
 * stream location is discovered from `ietf-restconf-monitoring:restconf-state`
 * (with or without the module prefix), an `EventSource` implementation the
 * host provides (or the browser global) subscribes, and the wrapper keeps a
 * capped exponential reconnect running until `close()` (or the signal)
 * releases it. SSE payload decoding stays with the host: notifications are
 * handed over raw (`{ data }`).
 */
export type RestconfStreamState = "connecting" | "open" | "reconnecting" | "closed";

export interface RestconfReconnectOptions {
  /** First wait before re-subscribing; default 500 ms. */
  delayMs?: number;
  /** Ceiling for the doubling wait; default 30 s. */
  maxDelayMs?: number;
}

export interface RestconfNotificationStreamOptions {
  /** Origin of the server, e.g. `https://host`. */
  baseUrl: string;
  /** Fetch implementation used for the stream discovery; falls back to `globalThis.fetch` at call time. */
  fetchImpl?: typeof fetch;
  /** Stream name from `ietf-restconf-monitoring`; default `NETCONF`. */
  stream?: string;
  /** Requested encoding of the stream access entry; default `json`. */
  encoding?: "xml" | "json";
  /** EventSource factory; defaults to the browser global when present. */
  createEventSource?: (url: string) => EventSource;
  /** One callback per SSE message; the payload stays the raw `data` text. */
  onNotification?: (notification: { data: string }) => void;
  /** Lifecycle states: connecting → open, reconnecting between retries, closed once. */
  onStateChange?: (state: RestconfStreamState) => void;
  /** Aborting stops the subscription and closes the source. */
  signal?: AbortSignal;
  /** Reconnect pacing (capped exponential). */
  reconnect?: RestconfReconnectOptions;
}

export interface RestconfNotificationStream {
  /** Resolves on the first `open`, rejects on discovery/EventSource failure. */
  readonly ready: Promise<void>;
  /** The discovered stream URL; undefined until discovery completed. */
  readonly streamUrl: string | undefined;
  /** Stop the subscription (idempotent); later errors/messages are ignored. */
  close(): void;
}

interface StreamAccess {
  encoding?: unknown;
  location?: unknown;
}

function findStreamLocation(payload: unknown, streamName: string, encoding: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const wrapper = payload as Record<string, unknown>;
  const state = (wrapper["ietf-restconf-monitoring:restconf-state"] ?? wrapper["restconf-state"] ?? wrapper) as
    Record<string, unknown> | undefined;
  const streams = state?.["streams"] as Record<string, unknown> | undefined;
  const list = streams?.["stream"];
  const rows = Array.isArray(list) ? list : list !== undefined ? [list] : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (record["name"] !== streamName) continue;
    const access = record["access"];
    const entries: StreamAccess[] = Array.isArray(access) ? access : access !== undefined ? [access] : [];
    for (const entry of entries) {
      if (entry?.encoding === encoding && typeof entry.location === "string") return entry.location;
    }
  }
  return undefined;
}

const joinUrl = (base: string, path: string): string => `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

export function createRestconfNotificationStream(options: RestconfNotificationStreamOptions): RestconfNotificationStream {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const reconnectDelay = options.reconnect?.delayMs ?? 500;
  const maxDelay = options.reconnect?.maxDelayMs ?? 30_000;
  const signal = options.signal;

  let streamState: RestconfStreamState = "connecting";
  let closed = false;
  let attempts = 0;
  let current: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let resolvedUrl: string | undefined;

  const emit = (state: RestconfStreamState): void => {
    streamState = state;
    options.onStateChange?.(state);
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener && signal) signal.removeEventListener("abort", abortListener);
    try {
      current?.close();
    } catch {
      // a wrapper that fails on close must not break the cleanup
    }
    current = undefined;
    emit("closed");
  };

  const openForever = (makeSource: (url: string) => EventSource, url: string): void => {
    const open = (): void => {
      if (closed) return;
      current = makeSource(url);
      current.onopen = () => {
        attempts = 0;
        emit("open");
      };
      current.onerror = () => {
        if (closed) return;
        if (current) {
          try {
            current.close();
          } catch {
            // ignore double-close from the implementation
          }
        }
        emit("reconnecting");
        timer = setTimeout(open, Math.min(maxDelay, reconnectDelay * 2 ** attempts));
        attempts++;
      };
      current.onmessage = (event: MessageEvent): void => {
        if (!closed) options.onNotification?.({ data: String(event.data) });
      };
    };
    open();
  };

  const ready = (async (): Promise<void> => {
    if (!fetchImpl) throw new Error("No fetch implementation available: pass fetchImpl in RestconfNotificationStreamOptions");
    if (signal?.aborted) throw signal.reason ?? new DOMException("Notification stream closed before opening", "AbortError");
    if (abortListener === undefined && signal) {
      abortListener = () => close();
      signal.addEventListener("abort", abortListener, { once: true });
    }
    const streamName = options.stream ?? "NETCONF";
    const encoding = options.encoding ?? "json";
    const discoveryUrl = joinUrl(
      options.baseUrl,
      `/restconf/data/ietf-restconf-monitoring:restconf-state/streams/stream=${encodeURIComponent(streamName)}`,
    );
    const response = await fetchImpl(discoveryUrl, {
      headers: { Accept: "application/yang-data+json" },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`Notification stream discovery failed: ${response.status} for ${discoveryUrl}`);
    }
    const location = findStreamLocation(await response.json(), streamName, encoding);
    if (!location) {
      throw new Error(`The server announces no '${streamName}' stream access with ${encoding} encoding`);
    }
    resolvedUrl = /^[\w+.-]+:\/\//.test(location) ? location : joinUrl(options.baseUrl, location);
    const makeSource = options.createEventSource ?? ((candidate: string): EventSource => {
      if (typeof globalThis.EventSource !== "function") {
        throw new Error("No EventSource implementation available: pass createEventSource or run in a browser");
      }
      return new globalThis.EventSource(candidate);
    });
    emit("connecting");
    openForever(makeSource, resolvedUrl);
  })();

  return {
    get ready(): Promise<void> {
      return ready;
    },
    get streamUrl(): string | undefined {
      return resolvedUrl;
    },
    close,
  };
}
