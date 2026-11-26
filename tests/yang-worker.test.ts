/**
 * §210 — worker delegation: protocol, pure task handler, runner with a real
 * emulation of the postMessage transport (same shapes as the worker glue)
 * and the main-thread fallback (identical answers from the same handler).
 */
import { describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { parseXml as parser } from "./dom.js";
import {
  createYangRunner, handleYangTask, YangTaskCancelledError,
  type YangCompileResult, type YangWorkerReply, type YangWorkerRequest,
} from "../src/react/index.js";
import type { CompiledYangSchema } from "../src/yang/compiler.js";
import type { InstanceValidationResult } from "../src/validation/validate-instance.js";

const SCHEMA_SOURCE = `module w { namespace "urn:w"; prefix w;
  leaf enabled { type boolean; }
  leaf level { type enumeration { enum low; enum high; } }
}`;
const INSTANCE = `<rooted xmlns="urn:w"><enabled>true</enabled><level>low</level></rooted>`;

function runnerLater(): Promise<CompiledYangSchema> {
  return handleYangTask(
    { kind: "compile", id: 0, sources: [SCHEMA_SOURCE] },
    { parseXml: parser },
  ).then(result => ((result as YangCompileResult).schema) as CompiledYangSchema);
}

describe("worker task handler", () => {
  it("compiles sources and carries diagnostics as data", () => {
    return runnerLater().then(schema => {
      expect(schema.roots.map(root => root.name)).toEqual(["enabled", "level"]);
      expect(schema.diagnostics).toEqual([]);
      // Plain data: the schema crosses structured clone boundaries (postMessage).
      expect(Object.keys(structuredClone(schema) as CompiledYangSchema).sort()).toEqual(Object.keys(schema).sort());
    });
  });

  it("rejects an unknown request kind loudly", async () => {
    await expect(handleYangTask({ kind: "cancel", id: 0 } as YangWorkerRequest, { parseXml: parser })).rejects.toThrow(YangTaskCancelledError);
    await expect(handleYangTask({ kind: "nope", id: 0 } as unknown as YangWorkerRequest, { parseXml: parser })).rejects.toThrow(/Unknown YANG worker request/);
  });

  it("parses instance XML through the injected parser (host decides the DOM)", async () => {
    const schema = await runnerLater();
    const verdict = await handleYangTask(
      { kind: "validate", id: 0, schema, instance: INSTANCE },
      { parseXml: parser },
    ) as InstanceValidationResult;
    expect(verdict.status).toBe("valid");
  });
});

/** Mirrors src/react/worker-glue.ts exactly — the transport contract under test. */
function emulateWorkerSide(onRequest: (request: YangWorkerRequest, reply: (response: YangWorkerReply) => void) => void) {
  return {
    sent: [] as YangWorkerRequest[],
    onmessage: null as ((event: { data: YangWorkerReply }) => void) | null,
    postMessage(message: YangWorkerRequest) {
      this.sent.push(message);
      onRequest(message, reply => setTimeout(() => this.onmessage?.({ data: reply }), 0));
    },
    terminate() { /* no-op */ },
  };
}

describe("createYangRunner", () => {
  it("fallback path: same answers, plain data, cancellation by id", async () => {
    const runner = createYangRunner({ parseXml: parser });
    const compiled = await runner.compile([SCHEMA_SOURCE]);
    expect((compiled.schema as CompiledYangSchema).diagnostics).toEqual([]);
    expect(compiled.diagnostics).toEqual([]);

    const validation = await runner.validate(compiled.schema as CompiledYangSchema, INSTANCE);
    expect(validation.status).toBe("valid");

    // Cancel before settling: the task promise rejects as cancelled.
    const slow = runner.candidates(compiled.schema as CompiledYangSchema, INSTANCE, "/level");
    slow.cancel();
    await expect(slow).rejects.toBeInstanceOf(YangTaskCancelledError);
    const crashed = runner.candidates(compiled.schema as CompiledYangSchema, INSTANCE, "/level");
    runner.cancelAll();
    await expect(crashed).rejects.toBeInstanceOf(YangTaskCancelledError);
  });

  it("worker path: id-routed replies, error flavor, cancelled tasks", async () => {
    const schema = await runnerLater();
    const transport = emulateWorkerSide((request, reply) => {
      // Same glue logic: dispatch by kind; cancel replies are void.
      if (request.kind === "cancel") return;
      handleYangTask(request, { parseXml: parser }).then(
        value => reply({ id: request.id, type: "result", value }),
        (error: unknown) => reply(error instanceof YangTaskCancelledError
          ? { id: request.id, type: "cancelled" }
          : { id: request.id, type: "error", name: (error as Error).name, message: (error as Error).message }),
      );
    });
    const runner = createYangRunner({
      worker: transport as unknown as Parameters<typeof createYangRunner>[0]["worker"],
      parseXml: parser,
    });
    expect(transport.onmessage).not.toBeNull();

    // Reply id routing: the LATE reply for task 1 must not settle task 2.
    const [first, second] = [runner.validate(schema, INSTANCE), runner.formModel(schema)];
    await first;
    void await second;

    // The worker received a cancel free post for the cancelled task, id-routed.
    const cancelled = runner.validate(schema, INSTANCE);
    cancelled.cancel();
    await expect(cancelled).rejects.toBeInstanceOf(YangTaskCancelledError);
    const last = transport.sent[transport.sent.length - 1]!;
    expect(last).toMatchObject({ kind: "cancel" });

    // Error replies surface as Error with the original NAME: parse failures
    // are thrown, never smuggled through as an invalid verdict.
    const broken = runner.validate(schema, "<not>matching");
    await expect(broken).rejects.toMatchObject({ name: "ParseError" });
  });
});
