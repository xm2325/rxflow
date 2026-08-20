import type { IncomingMessage } from "node:http";

/**
 * Convert a client-aborted HTTP upload/request into an AbortSignal that can be
 * propagated to cancellable downstream work such as an LLM request.
 */
export function requestAbortSignal(req: IncomingMessage): AbortSignal {
  const controller = new AbortController();
  req.on("aborted", () => {
    if (!controller.signal.aborted) controller.abort(new Error("client_request_aborted"));
  });
  return controller.signal;
}
