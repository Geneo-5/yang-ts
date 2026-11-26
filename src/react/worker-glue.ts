/**
 * §210 — module-worker entry: bridges `postMessage` to `handleYangTask`.
 * Loaded by `spawnYangWorker()` (or a bundler's worker import); never import
 * it directly from the UI thread.
 */
import { handleYangTask, YangTaskCancelledError } from "./worker-core.js";
import type { YangWorkerReply, YangWorkerRequest } from "./worker-protocol.js";

/** The worker's `DOMParser` handles the instance XML (browser worker scope). */
const environment = {
  parseXml: (text: string): Document => new DOMParser().parseFromString(text, "application/xml"),
};

const scope = self as unknown as {
  onmessage: ((event: { data: YangWorkerRequest }) => void) | null;
  postMessage(message: YangWorkerReply): void;
};

scope.onmessage = (event): void => {
  const request = event.data;
  handleYangTask(request, environment).then(
    value => scope.postMessage({ id: request.id, type: "result", value }),
    (error: unknown) => scope.postMessage(error instanceof YangTaskCancelledError
      ? { id: request.id, type: "cancelled" }
      : { id: request.id, type: "error", name: (error as Error).name, message: (error as Error).message }),
  );
};
