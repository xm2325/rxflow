import { readFile } from "node:fs/promises";
import { VERSION } from "./version.js";

interface ApiSpec {
  openapi?: string;
  info?: { version?: string };
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
}

const spec = JSON.parse(await readFile(new URL("../../docs/openapi.json", import.meta.url), "utf8")) as ApiSpec;
if (spec.openapi !== "3.1.0") throw new Error("openapi_version_mismatch");
if (spec.info?.version !== VERSION) throw new Error("openapi_release_version_mismatch");

const requiredOperations: Array<[string, string]> = [
  ["/health/live", "get"],
  ["/health/ready", "get"],
  ["/v1/fhir/MedicationRequest", "post"],
  ["/v1/fhir/Bundle", "post"],
  ["/v1/cases", "get"],
  ["/v1/work-queue", "get"],
  ["/v1/cases/{caseId}", "get"],
  ["/v1/cases/{caseId}/review-context", "get"],
  ["/v1/cases/{caseId}/approve", "post"],
  ["/v1/outbox/dead-letter", "get"],
  ["/v1/outbox/{eventId}/redrive", "post"],
  ["/v1/outbox/blocked-aggregates", "get"],
  ["/v1/outbox/retirement-requests", "get"],
  ["/v1/outbox/{eventId}/retirement-requests", "post"],
  ["/v1/outbox/retirement-requests/{requestId}/approve", "post"],
  ["/v1/outbox/{eventId}/recovery-history", "get"]
];
for (const [path, method] of requiredOperations) {
  if (!spec.paths?.[path]?.[method]) throw new Error(`openapi_missing_operation:${method}:${path}`);
}


for (const path of ["/v1/fhir/MedicationRequest", "/v1/fhir/Bundle"]) {
  const operationText = JSON.stringify(spec.paths?.[path]?.post);
  if (!operationText.includes("application/fhir+json")) throw new Error(`openapi_fhir_media_type_missing:${path}`);
  if (!operationText.includes("x-correlation-id")) throw new Error(`openapi_correlation_header_missing:${path}`);
  if (!operationText.includes("minLength") || !operationText.includes("maxLength") || !operationText.includes("x-idempotency-key")) {
    throw new Error(`openapi_idempotency_header_unbounded:${path}`);
  }
  if (!operationText.includes('"415"') || !operationText.includes('"413"')) throw new Error(`openapi_request_boundary_responses_missing:${path}`);
}

const securitySchemes = spec.components?.securitySchemes ?? {};
for (const name of ["ingestionBearer", "operationsBearer", "reviewBearer", "platformBearer"]) {
  if (!securitySchemes[name]) throw new Error(`openapi_missing_security_scheme:${name}`);
}

const redriveParameters = JSON.stringify(spec.paths?.["/v1/outbox/{eventId}/redrive"]?.post);
if (!redriveParameters.includes("If-Match")) throw new Error("openapi_redrive_missing_recovery_precondition");
const retirementRequestOperation = JSON.stringify(spec.paths?.["/v1/outbox/{eventId}/retirement-requests"]?.post);
if (!retirementRequestOperation.includes("If-Match") || !retirementRequestOperation.includes("platformBearer")) {
  throw new Error("openapi_retirement_request_missing_platform_precondition");
}
const retirementApprovalOperation = JSON.stringify(spec.paths?.["/v1/outbox/retirement-requests/{requestId}/approve"]?.post);
if (!retirementApprovalOperation.includes("platformBearer")) throw new Error("openapi_retirement_approval_missing_platform_auth");
if (spec.paths?.["/v1/outbox/{eventId}/retire"]) throw new Error("openapi_direct_retirement_bypass_present");

const retirementSchemaText = JSON.stringify(spec.components?.schemas?.RetirementApprovalRequestView);
if (!retirementSchemaText.includes("SUPERSEDED") || !retirementSchemaText.includes("supersededAt")) {
  throw new Error("openapi_retirement_request_missing_superseded_lifecycle");
}
const recoveryAuditSchemaText = JSON.stringify(spec.components?.schemas?.RecoveryAuditView);
if (!recoveryAuditSchemaText.includes("sequence") || !recoveryAuditSchemaText.includes("RETIREMENT_SUPERSEDED")) {
  throw new Error("openapi_recovery_audit_missing_causal_sequence");
}

const operationsText = JSON.stringify({
  summary: spec.components?.schemas?.CaseSummary,
  detail: spec.components?.schemas?.OperationsCaseDetail,
  ingest: spec.components?.schemas?.IngestResult,
  workQueue: spec.components?.schemas?.WorkQueueItem
});
for (const forbidden of ["patientReference", "clinicalNote", "evidenceValue", "answerText", "finalAnswer"]) {
  if (operationsText.includes(forbidden)) throw new Error(`openapi_operations_schema_exposes_sensitive_field:${forbidden}`);
}
const reviewerText = JSON.stringify(spec.components?.schemas?.ReviewerContext);
if (!reviewerText.includes("patientReference")) throw new Error("openapi_reviewer_context_missing_patient_reference");

const recoveryText = JSON.stringify({
  blocked: spec.components?.schemas?.BlockedAggregateRecoveryView,
  request: spec.components?.schemas?.RetirementApprovalRequestView,
  audit: spec.components?.schemas?.RecoveryAuditView
});
for (const forbidden of ["patientReference", "clinicalNote", "evidenceValue", "answerText", "finalAnswer"]) {
  if (recoveryText.includes(forbidden)) throw new Error(`openapi_recovery_schema_exposes_sensitive_field:${forbidden}`);
}

console.log(JSON.stringify({ apiContract: "ok", version: VERSION, operations: requiredOperations.length }));
