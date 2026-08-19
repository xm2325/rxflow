import { createServer } from "node:http";
import { createEventSink, loadConfig } from "./config.js";
import { BackgroundOutboxPublisher, OutboxDispatcher } from "./events.js";
import { MetricsRegistry } from "./metrics.js";
import { workerUnexpectedError } from "./operational-errors.js";
import { createConfiguredCaseStore } from "./runtime-store.js";
import { VERSION } from "./version.js";

const config = loadConfig({ ...process.env, RXFLOW_RUNTIME_ROLE: process.env.RXFLOW_RUNTIME_ROLE ?? "worker" });
if (config.runtimeRole !== "worker") throw new Error("worker_server_requires_worker_role");
const store = await createConfiguredCaseStore(config, process.env);
const metrics = new MetricsRegistry();
const dispatcher = new OutboxDispatcher(store, createEventSink(config), {
  maxAttempts: config.outboxMaxAttempts,
  workerId: config.workerId,
  leaseMs: config.outboxLeaseMs,
  retryBaseMs: config.outboxRetryBaseMs,
  retryMaxMs: config.outboxRetryMaxMs,
  perTenantClaimLimit: config.outboxPerTenantClaimLimit,
  tenantDeliveryConcurrency: config.outboxTenantDeliveryConcurrency,
  metrics
});
const publisher = new BackgroundOutboxPublisher(dispatcher, config.publishIntervalMs, (error) => {
  const mapped = workerUnexpectedError();
  metrics.increment("outbox_worker_errors");
  console.error(JSON.stringify({ event: "outbox_worker_error", code: mapped.code }));
});
if (config.publishIntervalMs > 0) publisher.start();

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (req.method === "GET" && pathname === "/health/live") return json(res, 200, { status: "ok", role: "worker", version: VERSION });
  if (req.method === "GET" && pathname === "/health/ready") {
    try {
      await store.healthCheck();
      return json(res, 200, { status: "ready", role: "worker", outbox: await store.getOutboxCounts() });
    } catch {
      return json(res, 503, { status: "not_ready", role: "worker" });
    }
  }
  if (req.method === "GET" && pathname === "/metrics") {
    return json(res, 200, {
      version: VERSION,
      role: "worker",
      worker: { ...publisher.snapshot(), activePublication: publisher.isActive() },
      counters: metrics.snapshot(),
      outbox: await store.getOutboxCounts(),
      queuePressure: await store.getOutboxPressure(config.outboxPendingAgeTargetMs)
    });
  }
  return json(res, 404, { error: "not_found" });
});
server.listen(config.port, () => console.log(JSON.stringify({ event: "rxflow_worker_started", port: config.port, version: VERSION, publishIntervalMs: config.publishIntervalMs })));

async function shutdown(signal: string): Promise<void> {
  publisher.stop();
  const drain = await publisher.waitForIdle(config.shutdownDrainTimeoutMs);
  if (!drain.idle) {
    metrics.increment("outbox_shutdown_drain_timeouts");
    console.error(JSON.stringify({ event: "outbox_shutdown_drain_timeout", code: "outbox_shutdown_drain_timeout", signal, timeoutMs: config.shutdownDrainTimeoutMs }));
  }
  server.close();
  server.closeIdleConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await store.close?.();
  console.log(JSON.stringify({ event: "rxflow_worker_stopped", signal, drain }));
}

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    shutdown(signal).then(() => process.exit(0)).catch(() => process.exit(1));
  });
}

function json(res: any, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
