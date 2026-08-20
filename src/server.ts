import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { createRuntimePaDraftGenerator } from "./runtime-ai.js";
import { loadRuntimeConfig } from "./config.js";
import { AppError, asAppError } from "./errors.js";
import { MetricsRegistry } from "./metrics.js";
import { BackgroundOutboxPublisher, OutboxDispatcher } from "./events.js";
import { createRuntimeStore, closeRuntimeStore } from "./storage-factory.js";
import { RxWorkflowService } from "./workflow.js";
import { createRuntimeEventSink } from "./runtime-event-sink.js";
import { evaluateReadiness } from "./readiness.js";
import { VERSION } from "./version.js";
import { caseEtag, parseCaseIfMatch, parseOutboxRecoveryIfMatch } from "./http-preconditions.js";
import { toCaseSummaryView, toOperationsCaseDetail, toOperationsIngestResult, toReviewerContextView } from "./case-view.js";
import { requestAbortSignal } from "./http-abort.js";
import { authorizeStaticBearer, authorizeStaticCredentialSet, reviewerIdentity, type ApiPrincipal, type ApiRole } from "./access-control.js";
import { approveDeadLetterRetirement, listBlockedAggregateRecoveryViews, listDeadLetterViews, listRecoveryHistory, redriveDeadLetter, requestDeadLetterRetirement } from "./outbox-ops.js";
import { responseHeaders } from "./http-security.js";
import { buildOperationsMetrics } from "./operations-metrics.js";
import { buildWorkQueue } from "./work-queue.js";
import { acceptedExternalCorrelationId, parseIdempotencyKey, rejectOversizeContentLength, requireJsonContentType } from "./http-request-contract.js";

const config = loadRuntimeConfig(process.env);
if (config.runtimeRole !== "api") throw new Error("api_server_requires_api_runtime_role");
const store = await createRuntimeStore(config);
const metrics = new MetricsRegistry();
const runtimeAi = createRuntimePaDraftGenerator(config);
const workflow = new RxWorkflowService(store, runtimeAi.generator, 3, metrics);
const shouldPublishInProcess = !config.externalOutboxWorker;
const eventSink = shouldPublishInProcess ? createRuntimeEventSink(config) : undefined;
const outboxPublisher = eventSink
  ? new BackgroundOutboxPublisher(new OutboxDispatcher(store, eventSink, config.outboxMaxAttempts, undefined, config.outboxLeaseMs, config.outboxBatchSize, config.outboxRetryBaseMs, config.outboxRetryMaxMs, Math.random, () => new Date(), config.outboxPerTenantClaimLimit, config.outboxTenantDeliveryConcurrency))
  : undefined;
const publishIntervalMs = config.publishIntervalMs;
const MAX_BODY_BYTES = 1024 * 1024;

function authHeader(req: IncomingMessage): string | undefined {
  return typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
}

function credentialPrincipal(req: IncomingMessage, role: ApiRole): ApiPrincipal | undefined {
  if (!config.credentials) return undefined;
  return authorizeStaticCredentialSet(authHeader(req), config.credentials, role);
}

function ingestionPrincipal(req: IncomingMessage): ApiPrincipal | undefined {
  if (config.credentials) return credentialPrincipal(req, "ingest");
  if (!config.ingestBearerToken) return undefined;
  return authorizeStaticBearer(authHeader(req), config.ingestBearerToken, "fhir-integration", "default", "ingest");
}

function operationsPrincipal(req: IncomingMessage): ApiPrincipal | undefined {
  if (config.credentials) return credentialPrincipal(req, "operations");
  if (!config.operationsBearerToken || !config.operationsPrincipal) return undefined;
  return authorizeStaticBearer(authHeader(req), config.operationsBearerToken, config.operationsPrincipal, "default", "operations");
}

function platformPrincipal(req: IncomingMessage): ApiPrincipal | undefined {
  if (config.credentials) return credentialPrincipal(req, "platform");
  return operationsPrincipal(req);
}

function recoveryPrincipal(req: IncomingMessage): ApiPrincipal {
  if (!config.credentials) {
    throw new AppError("recovery_auth_not_configured", 503, false, "Privileged recovery authentication is not configured.");
  }
  const principal = credentialPrincipal(req, "platform");
  if (!principal) throw new AppError("unauthorized", 401, false, "Valid bearer authentication is required.");
  return principal;
}

function reviewPrincipal(req: IncomingMessage): ApiPrincipal {
  if (config.credentials) return authorizeStaticCredentialSet(authHeader(req), config.credentials, "review");
  if (!config.reviewBearerToken || !config.reviewPrincipal) {
    throw new AppError("review_auth_not_configured", 503, false, "Reviewer authentication is not configured.");
  }
  return authorizeStaticBearer(authHeader(req), config.reviewBearerToken, config.reviewPrincipal, "default", "review");
}

function approvalPrincipal(req: IncomingMessage): ApiPrincipal | undefined {
  if (config.credentials) return reviewPrincipal(req);
  if (config.reviewBearerToken && config.reviewPrincipal) return reviewPrincipal(req);
  return operationsPrincipal(req);
}

function principalTenant(principal?: ApiPrincipal): string {
  return principal?.tenantId ?? "default";
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  correlationId?: string,
  extraHeaders: Record<string, string> = {}
): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, responseHeaders("application/json; charset=utf-8", correlationId, extraHeaders));
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string, correlationId: string): void {
  res.writeHead(status, responseHeaders("text/html; charset=utf-8", correlationId, {}, true));
  res.end(html);
}

function sendStaticText(res: ServerResponse, status: number, body: string, contentType: string, correlationId: string): void {
  res.writeHead(status, responseHeaders(contentType, correlationId, {}, true));
  res.end(body);
}

function sendError(res: ServerResponse, error: AppError, correlationId: string): void {
  send(res, error.httpStatus, {
    errors: [{
      code: error.code,
      title: error.httpStatus >= 500 ? "Service unavailable" : "Request failed",
      detail: error.publicDetail,
      meta: { correlationId, retryable: error.retryable }
    }]
  }, correlationId);
}

async function readJson(req: IncomingMessage, allowFhirJson = false): Promise<unknown> {
  requireJsonContentType(typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined, allowFhirJson);
  rejectOversizeContentLength(typeof req.headers["content-length"] === "string" ? req.headers["content-length"] : undefined, MAX_BODY_BYTES);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      throw new AppError("request_too_large", 413, false, "Request body exceeds the 1 MiB limit.");
    }
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("invalid_json", 400, false, "Request body is not valid JSON.");
  }
}

function requestCorrelationId(req: IncomingMessage): string {
  const supplied = acceptedExternalCorrelationId(req.headers["x-correlation-id"]);
  return supplied ?? randomUUID();
}

function triggerOutboxPublish(): void {
  if (!outboxPublisher) return;
  void outboxPublisher.tick().then((report) => {
    if (!report) return;
    if (report.published > 0) metrics.increment("outbox_events_published_total", report.published);
    if (report.failed > 0) metrics.increment("outbox_delivery_failures_total", report.failed);
    if (report.deadLettered > 0) metrics.increment("outbox_dead_lettered_total", report.deadLettered);
    if (report.staleClaims > 0) metrics.increment("outbox_stale_claims_total", report.staleClaims);
  }).catch(() => {
    metrics.increment("outbox_publisher_errors_total");
  });
}

const server = createServer(async (req, res) => {
  const correlationId = requestCorrelationId(req);
  try {
    if (req.method === "GET" && config.nodeEnv !== "production") {
      if (req.url === "/" || req.url === "/dashboard") {
        const html = await readFile(new URL("../../public/index.html", import.meta.url), "utf8");
        return sendHtml(res, 200, html, correlationId);
      }
      if (req.url === "/dashboard.css") {
        const css = await readFile(new URL("../../public/dashboard.css", import.meta.url), "utf8");
        return sendStaticText(res, 200, css, "text/css; charset=utf-8", correlationId);
      }
      if (req.url === "/dashboard.js") {
        const js = await readFile(new URL("../../public/dashboard.js", import.meta.url), "utf8");
        return sendStaticText(res, 200, js, "text/javascript; charset=utf-8", correlationId);
      }
    }

    if (req.method === "GET" && (req.url === "/health" || req.url === "/health/live")) {
      return send(res, 200, { status: "ok", service: "rxflow", version: VERSION }, correlationId);
    }

    if (req.method === "GET" && req.url === "/health/ready") {
      const report = await evaluateReadiness(store, config.readinessTimeoutMs);
      return send(res, report.status === "ready" ? 200 : 503, {
        status: report.status,
        storage: report.storage,
        latencyMs: report.latencyMs,
        service: "rxflow",
        version: VERSION,
        storageMode: config.storageMode
      }, correlationId);
    }

    if (req.method === "GET" && req.url === "/metrics") {
      platformPrincipal(req);
      return send(res, 200, await buildOperationsMetrics(store, metrics, config.outboxPendingAgeTargetMs), correlationId);
    }

    if (req.method === "GET" && req.url === "/v1/cases") {
      const principal = operationsPrincipal(req);
      const cases = (await workflow.list(principalTenant(principal))).map(toCaseSummaryView);
      return send(res, 200, { cases }, correlationId);
    }

    if (req.method === "GET" && req.url === "/v1/work-queue") {
      const principal = operationsPrincipal(req);
      return send(res, 200, { items: buildWorkQueue(await workflow.list(principalTenant(principal))) }, correlationId);
    }

    if (req.method === "GET" && req.url === "/v1/outbox/dead-letter") {
      const principal = operationsPrincipal(req);
      return send(res, 200, { events: await listDeadLetterViews(store, principalTenant(principal)) }, correlationId);
    }

    const redriveMatch = req.url?.match(/^\/v1\/outbox\/([^/]+)\/redrive$/);
    if (req.method === "POST" && redriveMatch) {
      const principal = operationsPrincipal(req);
      const expectedRecoveryGeneration = parseOutboxRecoveryIfMatch(
        typeof req.headers["if-match"] === "string" ? req.headers["if-match"] : undefined,
        redriveMatch[1]
      );
      const event = await redriveDeadLetter(store, redriveMatch[1], principalTenant(principal), expectedRecoveryGeneration, principal?.id);
      metrics.increment("outbox_redrives_total");
      triggerOutboxPublish();
      return send(res, 200, event, correlationId);
    }

    if (req.method === "GET" && req.url === "/v1/outbox/blocked-aggregates") {
      const principal = operationsPrincipal(req);
      return send(res, 200, { aggregates: await listBlockedAggregateRecoveryViews(store, principalTenant(principal)) }, correlationId);
    }

    if (req.method === "GET" && req.url === "/v1/outbox/retirement-requests") {
      const principal = recoveryPrincipal(req);
      return send(res, 200, { requests: await store.listRetirementApprovalRequests(principalTenant(principal)) }, correlationId);
    }

    const retirementRequestMatch = req.url?.match(/^\/v1\/outbox\/([^/]+)\/retirement-requests$/);
    if (req.method === "POST" && retirementRequestMatch) {
      const principal = recoveryPrincipal(req);
      const body = (await readJson(req)) as { reasonCode?: unknown; reference?: unknown };
      const expectedRecoveryGeneration = parseOutboxRecoveryIfMatch(
        typeof req.headers["if-match"] === "string" ? req.headers["if-match"] : undefined,
        retirementRequestMatch[1]
      );
      const request = await requestDeadLetterRetirement(
        store, retirementRequestMatch[1], principal.id, body.reasonCode, body.reference, principalTenant(principal), expectedRecoveryGeneration
      );
      metrics.increment("outbox_retirement_requests_total");
      return send(res, 201, request, correlationId);
    }

    const retirementApprovalMatch = req.url?.match(/^\/v1\/outbox\/retirement-requests\/([^/]+)\/approve$/);
    if (req.method === "POST" && retirementApprovalMatch) {
      const principal = recoveryPrincipal(req);
      const result = await approveDeadLetterRetirement(store, retirementApprovalMatch[1], principal.id, principalTenant(principal));
      metrics.increment("outbox_retirement_approvals_total");
      triggerOutboxPublish();
      return send(res, 200, result, correlationId);
    }

    const recoveryHistoryMatch = req.url?.match(/^\/v1\/outbox\/([^/]+)\/recovery-history$/);
    if (req.method === "GET" && recoveryHistoryMatch) {
      const principal = recoveryPrincipal(req);
      return send(res, 200, { history: await listRecoveryHistory(store, recoveryHistoryMatch[1], principalTenant(principal)) }, correlationId);
    }

    if (req.method === "POST" && (req.url === "/v1/fhir/MedicationRequest" || req.url === "/v1/fhir/Bundle")) {
      const principal = ingestionPrincipal(req);
      const body = await readJson(req, true);
      const key = parseIdempotencyKey(req.headers["x-idempotency-key"]);
      const result = await workflow.ingest(body, key, correlationId, requestAbortSignal(req), principalTenant(principal));
      const status = result.inProgress ? 202 : result.duplicate ? 200 : 201;
      triggerOutboxPublish();
      return send(res, status, toOperationsIngestResult(result), correlationId, { etag: caseEtag(result.case.id, result.case.version) });
    }

    const reviewContextMatch = req.url?.match(/^\/v1\/cases\/([^/]+)\/review-context$/);
    if (req.method === "GET" && reviewContextMatch) {
      const principal = reviewPrincipal(req);
      const rxCase = await workflow.get(reviewContextMatch[1], principalTenant(principal));
      if (!rxCase) throw new AppError("case_not_found", 404, false, "Case not found.");
      if (rxCase.status !== "HUMAN_REVIEW_REQUIRED") throw new AppError("case_not_reviewable", 409, false, "The case is not waiting for human review.");
      return send(res, 200, toReviewerContextView(rxCase), correlationId, { etag: caseEtag(rxCase.id, rxCase.version) });
    }

    const caseMatch = req.url?.match(/^\/v1\/cases\/([^/]+)$/);
    if (req.method === "GET" && caseMatch) {
      const principal = operationsPrincipal(req);
      const rxCase = await workflow.get(caseMatch[1], principalTenant(principal));
      if (!rxCase) throw new AppError("case_not_found", 404, false, "Case not found.");
      return send(res, 200, toOperationsCaseDetail(rxCase), correlationId, { etag: caseEtag(rxCase.id, rxCase.version) });
    }

    const approveMatch = req.url?.match(/^\/v1\/cases\/([^/]+)\/approve$/);
    if (req.method === "POST" && approveMatch) {
      const principal = approvalPrincipal(req);
      const body = (await readJson(req)) as { reviewer?: unknown; finalAnswer?: unknown };
      const reviewer = reviewerIdentity(body.reviewer, principal, config.nodeEnv !== "production" && !config.trustPlatformIam);
      const expectedVersion = parseCaseIfMatch(
        typeof req.headers["if-match"] === "string" ? req.headers["if-match"] : undefined,
        approveMatch[1]
      );
      const finalAnswer = body.finalAnswer === undefined ? undefined : body.finalAnswer;
      if (finalAnswer !== undefined && typeof finalAnswer !== "string") throw new AppError("invalid_review_answer", 400, false, "Reviewer answer must be a string.");
      const approved = await workflow.approve(approveMatch[1], reviewer, expectedVersion, finalAnswer, principalTenant(principal));
      triggerOutboxPublish();
      return send(res, 200, toOperationsCaseDetail(approved), correlationId, { etag: caseEtag(approved.id, approved.version) });
    }

    throw new AppError("not_found", 404, false, "Route not found.");
  } catch (error) {
    const safe = asAppError(error);
    metrics.increment("http_errors_total");
    if (safe.httpStatus >= 500) metrics.increment("http_5xx_total");
    console.error(JSON.stringify({ event: "request_error", code: safe.code, status: safe.httpStatus, correlationId }));
    sendError(res, safe, correlationId);
  }
});

const publishTimer = shouldPublishInProcess && publishIntervalMs > 0 ? setInterval(triggerOutboxPublish, publishIntervalMs) : undefined;
if (shouldPublishInProcess) triggerOutboxPublish();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (publishTimer) clearInterval(publishTimer);
  console.log(JSON.stringify({ event: "server_stopping", signal }));
  if (outboxPublisher) await outboxPublisher.tick().catch(() => undefined);
  server.close(() => {
    void closeRuntimeStore(store).finally(() => {
      console.log(JSON.stringify({ event: "server_stopped", signal }));
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 10_000);
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });

const port = config.port;
server.listen(port, () => {
  console.log(JSON.stringify({ event: "server_started", port, service: "rxflow", version: VERSION, storageMode: config.storageMode, outboxPublisher: shouldPublishInProcess ? "in_process" : "external" }));
});
