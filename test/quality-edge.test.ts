import assert from "node:assert/strict";
import test from "node:test";
import { asAppError, AppError } from "../src/errors.js";
import { normalizePrescriptionInput } from "../src/fhir.js";
import { buildWorkQueue } from "../src/work-queue.js";
import { GcpMetadataAccessTokenProvider, GcpPubSubEventSink } from "../src/gcp-pubsub.js";
import { AuthenticatedPubSubConsumerHandler } from "../src/consumer-http.js";
import { PubSubPushAdapter } from "../src/pubsub.js";
import { loadRuntimeConfig } from "../src/config.js";
import { createRuntimePaDraftGenerator } from "../src/runtime-ai.js";
import { createRuntimeStore, closeRuntimeStore } from "../src/storage-factory.js";
import { InMemoryCaseStore } from "../src/store.js";
import { acceptedExternalCorrelationId, parseIdempotencyKey, rejectOversizeContentLength, requireJsonContentType } from "../src/http-request-contract.js";
import { consumerOperationalError, workerOperationalErrorCode } from "../src/operational-errors.js";

const baseRequest = {
  resourceType: "MedicationRequest",
  id: "rx-quality",
  subject: { reference: "Patient/synthetic-quality" },
  medicationCodeableConcept: { coding: [{ code: "12345" }] },
  note: [{ text: "Prior methotrexate trial documented." }]
};

test("unknown errors are converted to a non-retryable public-safe internal error", () => {
  const converted = asAppError(new Error("database_password=must-not-leak"));
  assert.equal(converted.code, "internal_error");
  assert.equal(converted.httpStatus, 500);
  assert.equal(converted.retryable, false);
  assert.equal(converted.publicDetail, "Unexpected internal error.");
  assert.equal(converted.publicDetail.includes("must-not-leak"), false);
  const existing = new AppError("known", 409, false, "Known detail");
  assert.equal(asAppError(existing), existing);
});


test("operational error mapping discards unexpected error messages while preserving bounded request codes", () => {
  const sentinel = "Patient/private-123 clinical-note-must-not-log";
  assert.equal(workerOperationalErrorCode(new Error(sentinel)), "outbox_worker_internal_error");
  assert.equal(consumerOperationalError(new Error(sentinel)).code, "consumer_internal_error");
  assert.equal(consumerOperationalError(new Error(sentinel)).status, 500);
  assert.equal(consumerOperationalError(new Error("consumer_request_too_large")).code, "consumer_request_too_large");
  assert.equal(consumerOperationalError(new Error("consumer_request_too_large")).status, 413);
  assert.equal(consumerOperationalError(new Error("consumer_invalid_json")).status, 400);
  assert.equal(consumerOperationalError(new AppError("pubsub_auth_invalid", 401, false, "Invalid authentication.")).code, "pubsub_auth_invalid");
});

test("FHIR Bundle resolves Coverage class when payer display/reference is absent", () => {
  const normalized = normalizePrescriptionInput({
    resourceType: "Bundle",
    entry: [
      { resource: { resourceType: "Coverage", id: "cov-class", class: [{ value: "PLAN-CLASS-42", name: "Synthetic Gold Plan" }] } },
      { resource: { ...baseRequest, insurance: [{ reference: "Coverage/cov-class" }] } }
    ]
  });
  assert.equal(normalized.payerPlan, "Synthetic Gold Plan");
});

test("FHIR input rejects non-object, missing Bundle.entry, and a Task without focus", () => {
  assert.throws(() => normalizePrescriptionInput("not-fhir"), /invalid_fhir/);
  assert.throws(() => normalizePrescriptionInput({ resourceType: "Bundle" }), /invalid_fhir_bundle/);
  assert.throws(() => normalizePrescriptionInput({
    resourceType: "Bundle",
    entry: [
      { resource: baseRequest },
      { resource: { resourceType: "Task", id: "task-no-focus" } }
    ]
  }), /invalid_fhir/);
});

test("work queue orders pharmacist review before retryable and terminal operator work", () => {
  const common = {
    version: 1,
    eventSequence: 1,
    correlationId: "corr-quality",
    sourceResourceId: "rx-quality",
    patientReference: "Patient/private",
    medicationCode: "12345",
    payerPlan: "PLAN",
    priorAuthRequired: true,
    audit: []
  };
  const queue = buildWorkQueue([
    { ...common, id: "terminal", status: "FAILED" },
    { ...common, id: "retry", status: "FAILED_RETRYABLE" },
    { ...common, id: "review", status: "HUMAN_REVIEW_REQUIRED" },
    { ...common, id: "routed", status: "ROUTED" }
  ] as never[]);
  assert.equal(JSON.stringify(queue.map((item) => item.action)), JSON.stringify([
    "PHARMACIST_REVIEW", "RETRYABLE_WORKFLOW_FAILURE", "OPERATOR_REVIEW"
  ]));
  assert.equal(JSON.stringify(queue).includes("Patient/private"), false);
});

test("GCP metadata token provider fails closed on HTTP and malformed token responses", async () => {
  const httpFailure = new GcpMetadataAccessTokenProvider(async () => ({
    ok: false, status: 503, async json() { return {}; }
  }));
  await assert.rejects(() => httpFailure.getAccessToken(), /gcp_metadata_http_503/);

  const malformed = new GcpMetadataAccessTokenProvider(async () => ({
    ok: true, status: 200, async json() { return { access_token: "", expires_in: -1 }; }
  }));
  await assert.rejects(() => malformed.getAccessToken(), /invalid_gcp_metadata_token/);
});

test("GCP metadata token invalidation affects only the exact cached token", async () => {
  let calls = 0;
  const provider = new GcpMetadataAccessTokenProvider(async () => {
    calls += 1;
    return { ok: true, status: 200, async json() { return { access_token: `token-${calls}`, expires_in: 3600 }; } };
  }, () => 1_000);
  assert.equal(await provider.getAccessToken(), "token-1");
  provider.invalidateAccessToken("other-token");
  assert.equal(await provider.getAccessToken(), "token-1");
  provider.invalidateAccessToken("token-1");
  assert.equal(await provider.getAccessToken(), "token-2");
});

test("Pub/Sub sink rejects invalid project/topic identifiers before any network call", () => {
  const tokenProvider = { async getAccessToken() { return "token"; } };
  assert.throws(() => new GcpPubSubEventSink("bad project", "topic", tokenProvider), /invalid_pubsub_project/);
  assert.throws(() => new GcpPubSubEventSink("project", "bad/topic", tokenProvider), /invalid_pubsub_topic/);
});

test("authenticated consumer maps auth and contract failures but rethrows unexpected failures", async () => {
  const authFailure = new AuthenticatedPubSubConsumerHandler(
    { async verifyAuthorizationHeader() { throw new Error("pubsub_auth_invalid_signature"); } },
    { consume() { throw new Error("should_not_run"); } } as unknown as PubSubPushAdapter
  );
  assert.equal((await authFailure.handle(undefined, {})).status, 401);

  const contractFailure = new AuthenticatedPubSubConsumerHandler(
    { async verifyAuthorizationHeader() { return { email: "svc@example.test" } as never; } },
    { consume() { throw new Error("invalid_integration_event:type"); } } as unknown as PubSubPushAdapter
  );
  assert.equal((await contractFailure.handle("Bearer x", {})).status, 400);

  const unexpected = new AuthenticatedPubSubConsumerHandler(
    { async verifyAuthorizationHeader() { return { email: "svc@example.test" } as never; } },
    { consume() { throw new Error("unexpected_consumer_bug"); } } as unknown as PubSubPushAdapter
  );
  await assert.rejects(() => unexpected.handle("Bearer x", {}), /unexpected_consumer_bug/);
});

test("runtime AI factory preserves the mandatory human-review policy", async () => {
  const config = loadRuntimeConfig({});
  const runtime = createRuntimePaDraftGenerator(config);
  const draft = await runtime.generator.generate({
    resourceId: "rx-runtime-ai",
    patientReference: "Patient/synthetic",
    medicationCode: "12345",
    payerPlan: "PLAN",
    clinicalNote: "Prior therapy with methotrexate was documented."
  });
  assert.equal(draft.requiresHumanReview, true);
  assert.equal(runtime.breaker.snapshot().state, "CLOSED");
});

test("runtime store factory creates and closes the self-contained memory store", async () => {
  const store = await createRuntimeStore(loadRuntimeConfig({}));
  assert.ok(store instanceof InMemoryCaseStore);
  await closeRuntimeStore(store);
});


test("HTTP request metadata accepts opaque correlation IDs but rejects free-form identifiers", () => {
  assert.equal(acceptedExternalCorrelationId("123e4567-e89b-12d3-a456-426614174000"), "123e4567-e89b-12d3-a456-426614174000");
  assert.equal(acceptedExternalCorrelationId("0123456789abcdef0123456789abcdef"), "0123456789abcdef0123456789abcdef");
  assert.equal(acceptedExternalCorrelationId("Patient-Alice-MRN-123"), undefined);
  assert.equal(acceptedExternalCorrelationId("0123456789abcdef0123456789abcdef extra"), undefined);
});

test("HTTP idempotency keys are bounded opaque tokens", () => {
  assert.equal(parseIdempotencyKey(undefined), undefined);
  assert.equal(parseIdempotencyKey("opaque-key-12345"), "opaque-key-12345");
  assert.throws(() => parseIdempotencyKey("short"), /invalid_idempotency_key/);
  assert.throws(() => parseIdempotencyKey("patient jane mrn 123"), /invalid_idempotency_key/);
  assert.throws(() => parseIdempotencyKey("x".repeat(129)), /invalid_idempotency_key/);
});

test("HTTP JSON media types and UTF-8 are enforced", () => {
  requireJsonContentType("application/json");
  requireJsonContentType("application/json; charset=utf-8");
  requireJsonContentType("application/fhir+json; charset=UTF-8", true);
  assert.throws(() => requireJsonContentType(undefined), /unsupported_media_type/);
  assert.throws(() => requireJsonContentType("text/plain"), /unsupported_media_type/);
  assert.throws(() => requireJsonContentType("application/fhir+json"), /unsupported_media_type/);
  assert.throws(() => requireJsonContentType("application/json; charset=iso-8859-1"), /unsupported_charset/);
});

test("Content-Length is rejected before body accumulation when it exceeds the configured limit", () => {
  rejectOversizeContentLength(undefined, 1024);
  rejectOversizeContentLength("1024", 1024);
  assert.throws(() => rejectOversizeContentLength("1025", 1024), /request_too_large/);
  assert.throws(() => rejectOversizeContentLength("not-a-number", 1024), /invalid_content_length/);
});
