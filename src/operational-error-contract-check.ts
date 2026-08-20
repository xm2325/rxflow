import { readFileSync } from "node:fs";

const files = {
  server: readFileSync("src/server.ts", "utf8"),
  worker: readFileSync("src/worker-server.ts", "utf8"),
  consumer: readFileSync("src/consumer-server.ts", "utf8"),
  events: readFileSync("src/events.ts", "utf8")
};

const forbidden = [
  /console\.(?:error|log|warn)\([^\n]*error\.message/,
  /lastErrorCode\s*=\s*error\s+instanceof\s+Error\s*\?\s*error\.message/,
  /lastError\s*=\s*error\s+instanceof\s+Error\s*\?\s*error\.message/
];

for (const [name, source] of Object.entries(files)) {
  for (const pattern of forbidden) {
    if (pattern.test(source)) throw new Error(`raw_operational_error_message:${name}`);
  }
}

if (!files.events.includes('message: "delivery_internal_error"')) throw new Error("missing_bounded_delivery_internal_error");
if (!files.worker.includes("workerOperationalErrorCode(error)")) throw new Error("worker_error_boundary_missing");
if (!files.consumer.includes("consumerOperationalError(error)")) throw new Error("consumer_error_boundary_missing");
if (!files.server.includes("asAppError(error)")) throw new Error("api_error_boundary_missing");

console.log(JSON.stringify({
  operationalErrorBoundary: "ok",
  rawErrorMessageLogging: false,
  boundedUnexpectedCodes: ["internal_error", "outbox_worker_internal_error", "consumer_internal_error", "delivery_internal_error"]
}));
