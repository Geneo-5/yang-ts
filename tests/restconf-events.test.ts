import { describe, expect, it } from "vitest";
import { createRestconfNotificationStream } from "../src/index.js";
import type { RestconfStreamState } from "../src/index.js";

/** Minimal EventSource double: the test drives open/error/message. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState: number = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  private closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  fail(): void {
    this.readyState = FakeEventSource.CLOSED; // server closed the stream
    this.onerror?.();
  }
}

const DISCOVERED = {
  "ietf-restconf-monitoring:restconf-state": {
    streams: {
      stream: [{
        name: "NETCONF",
        description: "default event stream",
        replaySupport: false,
        access: [
          { encoding: "xml", location: "/restconf/streams/netconf-xml" },
          { encoding: "json", location: "/restconf/streams/netconf-json" },
        ],
      }],
    },
  },
};

const STREAM_DISCOVERY = (async (url: string): Promise<Response> => {
  void url;
  return { ok: true, status: 200, json: async () => DISCOVERED } as unknown as Response;
}) as unknown as typeof fetch;

const wait = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

async function settle(promise: Promise<unknown>, ms = 80): Promise<unknown> {
  const failure = await Promise.race([
    promise.then(() => undefined, (cause: unknown) => cause),
    wait(ms).then(() => "PENDING"),
  ]);
  return failure;
}

describe("createRestconfNotificationStream (§204)", () => {
  it("discovers the stream location and opens the EventSource on it", async () => {
    FakeEventSource.instances = [];
    const states: RestconfStreamState[] = [];
    const subscription = createRestconfNotificationStream({
      baseUrl: "https://host",
      fetchImpl: STREAM_DISCOVERY,
      createEventSource: url => new FakeEventSource(url) as unknown as EventSource,
      onStateChange: state => states.push(state),
    });
    await subscription.ready;
    FakeEventSource.instances[0]!.onopen?.();
    expect(FakeEventSource.instances[0]!.url).toBe("https://host/restconf/streams/netconf-json");
    expect(states).toEqual(["connecting", "open"]);
    subscription.close();
  });

  it("prefers the requested encoding and hands SSE data to onNotification", async () => {
    FakeEventSource.instances = [];
    const seen: string[] = [];
    const subscription = createRestconfNotificationStream({
      baseUrl: "https://host",
      fetchImpl: STREAM_DISCOVERY,
      encoding: "xml",
      createEventSource: url => new FakeEventSource(url) as unknown as EventSource,
      onNotification: notification => seen.push(notification.data),
    });
    await subscription.ready;
    FakeEventSource.instances[0]!.onmessage?.({ data: "<notification/>" });
    expect(seen).toEqual(["<notification/>"]);
    subscription.close();
  });

  it("reconnects with capped exponential backoff when the stream closes", async () => {
    FakeEventSource.instances = [];
    const states: RestconfStreamState[] = [];
    const subscription = createRestconfNotificationStream({
      baseUrl: "https://host",
      fetchImpl: STREAM_DISCOVERY,
      createEventSource: url => new FakeEventSource(url) as unknown as EventSource,
      reconnect: { delayMs: 1, maxDelayMs: 4 },
      onStateChange: state => states.push(state),
    });
    await subscription.ready;
    const first = FakeEventSource.instances[0]!;
    first.fail();
    await wait(30);
    expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2);
    const second = FakeEventSource.instances[1]!;
    expect(second.url).toBe(first.url);
    second.onopen?.();
    subscription.close();
    expect(states).toContain("reconnecting");
  });

  it("stops cleanly: close() closes the source and swallows later errors, abort does the same", async () => {
    FakeEventSource.instances = [];
    const controller = new AbortController();
    const subscription = createRestconfNotificationStream({
      baseUrl: "https://host",
      fetchImpl: STREAM_DISCOVERY,
      createEventSource: url => new FakeEventSource(url) as unknown as EventSource,
      signal: controller.signal,
      reconnect: { delayMs: 1 },
    });
    await subscription.ready;
    const source = FakeEventSource.instances[0]!;
    subscription.close();
    expect(source.isClosed).toBe(true);
    source.fail();
    source.onmessage?.({ data: "late" });
    await wait(10);
    expect(FakeEventSource.instances.length).toBe(1); // aucun rebranchement après close()
    // Le même nettoyage passe par le signal d'annulation.
    const second = createRestconfNotificationStream({
      baseUrl: "https://host",
      fetchImpl: STREAM_DISCOVERY,
      createEventSource: url => new FakeEventSource(url) as unknown as EventSource,
      signal: controller.signal,
      reconnect: { delayMs: 1 },
    });
    controller.abort();
    await settle(second.ready);
    expect(FakeEventSource.instances.length).toBe(1);
  });

  it("rejects ready when discovery fails and opens nothing", async () => {
    FakeEventSource.instances = [];
    const discovery = (async (): Promise<{ ok: boolean }> => ({ ok: false })) as unknown as typeof fetch;
    const subscription = createRestconfNotificationStream({
      baseUrl: "https://host",
      fetchImpl: discovery,
      createEventSource: url => new FakeEventSource(url) as unknown as EventSource,
    });
    const failure = await settle(subscription.ready);
    expect((failure as Error).message).toMatch(/stream/i);
    expect(FakeEventSource.instances.length).toBe(0);
  });

  it("requires an EventSource implementation when the global one is absent", async () => {
    FakeEventSource.instances = [];
    const holder = globalThis as { EventSource?: unknown };
    const globalSource = holder.EventSource;
    holder.EventSource = undefined;
    try {
      const subscription = createRestconfNotificationStream({
        baseUrl: "https://host",
        fetchImpl: STREAM_DISCOVERY,
      });
      const failure = await settle(subscription.ready);
      expect((failure as Error).message).toMatch(/EventSource/);
    } finally {
      holder.EventSource = globalSource;
    }
  });
});
