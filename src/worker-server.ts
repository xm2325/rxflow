import { createServer } from "node:http";
import { loadRuntimeConfig } from "./config.js";
import { BackgroundOutboxPublisher, OutboxDispatcher } from "./events.js";
import { responseHeaders } from "./http-security.js";
import { createRuntimeEventSink } from "./runtime-event-sink.js";
import { closeRuntimeStore, createRuntimeStore } from "./storage-factory.js";
import { VERSION } from "./version.js";
import { workerOperationalErrorCode } from "./operational-errors.js";

const config = loadRuntimeConfig({ ...process.env, RXFLOW_RUNTIME_ROLE: process.env.RXFLOW_RUNTIME_ROLE ?? "worker" });
if (config.runtimeRole !== "worker") throw new Error("outbox_worker_requires_worker_runtime_role");

const store = await createRuntimeStore(config);
const sink = createRuntimeEventSink(config);
const publisher = new BackgroundOutboxPublisher(
  new OutboxDispatcher(store, sink, config.outboxMaxAttempts, undefined, config.outboxLeaseMs, config.outboxBatchSize, config.outboxRetryBaseMs, config.outboxRetryMaxMs, Math.random, () => new Date(), config.outboxPerTenantClaimLimit, config.outboxTenantDeliveryConcurrency)
);

let lastTickAt: string | undefined;
let lastSuccessfulTickAt: string | undefined;
let lastErrorAt: string | undefined;
let lastErrorCode: string | undefined;
let ticks = 0;
let claimed = 0;
let attempted = 0;
let published = 0;
let failed = 0;
let deadLettered = 0;
let staleClaims = 0;
let leaseRenewals = 0;
let leaseRenewalFailures = 0;
let terminalFailures = 0;
let deferred = 0;
let batchShortCircuits = 0;
let tenantShortCircuits = 0;
let globalShortCircuits = 0;
let peakConcurrentDeliveries = 0;
let shuttingDown = false;

function send(res: { writeHead(statusCode: number, headers?: Record<string, string>): void; end(data?: string): void }, status: number, body: unknown): void {
  res.writeHead(status, responseHeaders("application/json; charset=utf-8"));
  res.end(JSON.stringify(body, null, 2));
}

async function tick(): Promise<void> {
  if (shuttingDown) return;
  lastTickAt = new Date().toISOString();
  try {
    const report = await publisher.tick();
    if (!report) return;
    ticks += 1;
    claimed += report.claimed;
    attempted += report.attempted;
    published += report.published;
    failed += report.failed;
    deadLettered += report.deadLettered;
    staleClaims += report.staleClaims;
    leaseRenewals += report.leaseRenewals;
    leaseRenewalFailures += report.leaseRenewalFailures;
    terminalFailures += report.terminalFailures;
    deferred += report.deferred;
    batchShortCircuits += report.batchShortCircuits;
    tenantShortCircuits += report.tenantShortCircuits;
    globalShortCircuits += report.globalShortCircuits;
    peakConcurrentDeliveries = Math.max(peakConcurrentDeliveries, report.peakConcurrentDeliveries);
    lastSuccessfulTickAt = new Date().toISOString();
    lastErrorCode = undefined;
  } catch (error) {
    lastErrorAt = new Date().toISOString();
    // Do not turn an arbitrary database/provider Error.message into metrics or logs.
    // Lower layers retain bounded delivery codes for expected transport failures.
    lastErrorCode = workerOperationalErrorCode(error);
    console.error(JSON.stringify({ event: "outbox_worker_tick_failed", code: lastErrorCode }));
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/health/live")) {
    return send(res, 200, { status: "ok", service: "rxflow-outbox-worker", version: VERSION });
  }
  if (req.method === "GET" && req.url === "/health/ready") {
    try {
      await store.healthCheck();
      const outbox = await store.getOutboxCounts();
      return send(res, 200, {
        status: "ready",
        service: "rxflow-outbox-worker",
        version: VERSION,
        storageMode: config.storageMode,
        outbox: { pending: outbox.pending, inFlight: outbox.inFlight, deadLetter: outbox.deadLetter }
      });
    } catch {
      return send(res, 503, { status: "not_ready", service: "rxflow-outbox-worker", version: VERSION });
    }
  }
  if (req.method === "GET" && req.url === "/metrics") {
    const outbox = await store.getOutboxCounts();
    const pressure = await store.getOutboxPressure(config.outboxPendingAgeTargetMs);
    const largestTenantShare = pressure.pending > 0 ? pressure.largestTenantPending / pressure.pending : 0;
    return send(res, 200, {
      service: "rxflow-outbox-worker",
      version: VERSION,
      worker: {
        ticks,
        claimed,
        attempted,
        published,
        failed,
        deadLettered,
        staleClaims,
        leaseRenewals,
        leaseRenewalFailures,
        terminalFailures,
        deferred,
        batchShortCircuits,
        tenantShortCircuits,
        globalShortCircuits,
        peakConcurrentDeliveries,
        tenantDeliveryConcurrency: config.outboxTenantDeliveryConcurrency,
        activePublication: publisher.isActive(),
        lastTickAt: lastTickAt ?? null,
        lastSuccessfulTickAt: lastSuccessfulTickAt ?? null,
        lastErrorAt: lastErrorAt ?? null,
        lastErrorCode: lastErrorCode ?? null
      },
      outbox,
      queuePressure: {
        pending: pressure.pending,
        activePendingTenants: pressure.activePendingTenants,
        largestTenantPending: pressure.largestTenantPending,
        largestTenantShare,
        pendingAgeTargetMs: config.outboxPendingAgeTargetMs,
        oldestPendingAgeMs: pressure.oldestPendingAgeMs,
        overduePending: pressure.overduePending,
        overduePendingTenants: pressure.overduePendingTenants,
        orderedBlockedPending: pressure.orderedBlockedPending,
        orderedBlockedAggregates: pressure.orderedBlockedAggregates,
        targetBreached: pressure.overduePending > 0
      }
    });
  }
  return send(res, 404, { error: "not_found" });
});

const timer = setInterval(() => { void tick(); }, config.publishIntervalMs);
void tick();

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);
  console.log(JSON.stringify({ event: "outbox_worker_stopping", signal }));
  const drained = await publisher.waitForIdle(8_000);
  if (!drained) {
    console.error(JSON.stringify({ event: "outbox_worker_shutdown_drain_timeout", signal }));
  }
  server.close(() => {
    void closeRuntimeStore(store).finally(() => {
      console.log(JSON.stringify({ event: "outbox_worker_stopped", signal }));
      process.exit(0);
    });
  });
  // Health/metrics probes commonly leave keep-alive sockets open. They should not
  // extend a rolling-deployment shutdown after the active delivery has drained.
  (server as unknown as { closeIdleConnections?: () => void }).closeIdleConnections?.();
  setTimeout(() => process.exit(1), 10_000);
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });

server.listen(config.port, () => {
  console.log(JSON.stringify({
    event: "outbox_worker_started",
    port: config.port,
    service: "rxflow-outbox-worker",
    version: VERSION,
    storageMode: config.storageMode,
    eventSinkMode: config.eventSinkMode,
    publishIntervalMs: config.publishIntervalMs,
    batchSize: config.outboxBatchSize,
    perTenantClaimLimit: config.outboxPerTenantClaimLimit,
    tenantDeliveryConcurrency: config.outboxTenantDeliveryConcurrency,
    leaseMs: config.outboxLeaseMs
  }));
});
