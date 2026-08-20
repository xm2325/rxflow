import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const port = 18000 + (process.pid % 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = `/tmp/rxflow-http-smoke-${process.pid}.db`;
const ingestToken = "ingest-a-token-123456789012345678901234";
const operationsToken = "operations-a-token-123456789012345678901";
const reviewToken = "review-a-token-123456789012345678901234";
const reviewPrincipal = "pharmacist-http-smoke-a";
const secondReviewToken = "review-a2-token-12345678901234567890123";
const secondReviewPrincipal = "pharmacist-http-smoke-a2";
const ingestTokenB = "ingest-b-token-123456789012345678901234";
const operationsTokenB = "operations-b-token-123456789012345678901";
const reviewTokenB = "review-b-token-123456789012345678901234";
const platformToken = "platform-token-123456789012345678901234";
const credentials = JSON.stringify([
  { token: ingestToken, principal: "fhir-a", tenantId: "health-a", roles: ["ingest"] },
  { token: operationsToken, principal: "ops-a", tenantId: "health-a", roles: ["operations"] },
  { token: reviewToken, principal: reviewPrincipal, tenantId: "health-a", roles: ["review"] },
  { token: secondReviewToken, principal: secondReviewPrincipal, tenantId: "health-a", roles: ["review"] },
  { token: ingestTokenB, principal: "fhir-b", tenantId: "health-b", roles: ["ingest"] },
  { token: operationsTokenB, principal: "ops-b", tenantId: "health-b", roles: ["operations"] },
  { token: reviewTokenB, principal: "pharmacist-http-smoke-b", tenantId: "health-b", roles: ["review"] },
  { token: platformToken, principal: "platform-http-smoke", tenantId: "platform", roles: ["platform"] }
]);

await unlink(dbPath).catch(() => undefined);
const child = spawn(process.execPath, ["dist/src/server.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    RXFLOW_SQLITE_FILE: dbPath,
    RXFLOW_REQUIRE_API_AUTH: "true",
    RXFLOW_CREDENTIALS_JSON: credentials,
    RXFLOW_PUBLISH_INTERVAL_MS: "0"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

async function waitUntilReady() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health/live`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`http_smoke_server_start_timeout:${stderr}`);
}

async function shutdown() {
  if (child.exitCode === null) child.kill("SIGTERM");
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(undefined);
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(undefined); }, 2000);
    child.once("exit", () => { clearTimeout(timer); resolve(undefined); });
  });
}

try {
  await waitUntilReady();
  const fixture = JSON.parse(await readFile(new URL("../fixtures/medication-request.json", import.meta.url), "utf8"));
  const taskBundle = JSON.parse(await readFile(new URL("../fixtures/fhir-task-bundle.json", import.meta.url), "utf8"));

  const unauthenticated = await fetch(`${baseUrl}/v1/fhir/MedicationRequest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fixture)
  });
  assert.equal(unauthenticated.status, 401);

  const ingest = await fetch(`${baseUrl}/v1/fhir/MedicationRequest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ingestToken}`,
      "x-idempotency-key": "shared-http-smoke-key"
    },
    body: JSON.stringify(fixture)
  });
  assert.equal(ingest.status, 201);
  assert.equal(ingest.headers.get("cache-control"), "no-store");
  assert.equal(ingest.headers.get("x-content-type-options"), "nosniff");
  const etag = ingest.headers.get("etag");
  assert.ok(etag);
  const ingestBody = await ingest.json();
  const caseId = ingestBody.case.id;

  const ingestB = await fetch(`${baseUrl}/v1/fhir/MedicationRequest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ingestTokenB}`,
      "x-idempotency-key": "shared-http-smoke-key"
    },
    body: JSON.stringify(fixture)
  });
  assert.equal(ingestB.status, 201);
  const ingestBodyB = await ingestB.json();
  const caseIdB = ingestBodyB.case.id;
  assert.ok(caseIdB !== caseId);

  const operations = await fetch(`${baseUrl}/v1/cases`, { headers: { authorization: `Bearer ${operationsToken}` } });
  assert.equal(operations.status, 200);
  const operationsBody = await operations.json();
  assert.ok(operationsBody.cases.some((item) => item.id === caseId));
  assert.equal(operationsBody.cases.some((item) => item.id === caseIdB), false);

  const operationsB = await fetch(`${baseUrl}/v1/cases`, { headers: { authorization: `Bearer ${operationsTokenB}` } });
  assert.equal(operationsB.status, 200);
  const operationsBodyB = await operationsB.json();
  assert.ok(operationsBodyB.cases.some((item) => item.id === caseIdB));
  assert.equal(operationsBodyB.cases.some((item) => item.id === caseId), false);

  const crossTenantRead = await fetch(`${baseUrl}/v1/cases/${caseIdB}`, { headers: { authorization: `Bearer ${operationsToken}` } });
  assert.equal(crossTenantRead.status, 404);

  const crossTenantReview = await fetch(`${baseUrl}/v1/cases/${caseIdB}/review-context`, { headers: { authorization: `Bearer ${reviewToken}` } });
  assert.equal(crossTenantReview.status, 404);

  const taskIngest = await fetch(`${baseUrl}/v1/fhir/Bundle`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ingestToken}`,
      "x-idempotency-key": "http-smoke-task-v64"
    },
    body: JSON.stringify(taskBundle)
  });
  assert.equal(taskIngest.status, 201);
  const taskBody = await taskIngest.json();
  assert.equal(taskBody.case.sourceWorkflow, "FHIR_TASK");
  assert.equal(taskBody.case.sourceTaskId, "task-msot-001");

  const workQueue = await fetch(`${baseUrl}/v1/work-queue`, { headers: { authorization: `Bearer ${operationsToken}` } });
  assert.equal(workQueue.status, 200);
  const workQueueBody = await workQueue.json();
  assert.ok(workQueueBody.items.some((item) => item.caseId === caseId && item.action === "PHARMACIST_REVIEW"));
  assert.ok(workQueueBody.items.some((item) => item.caseId === taskBody.case.id && item.sourceWorkflow === "FHIR_TASK"));
  assert.equal(JSON.stringify(workQueueBody).includes("Patient/synthetic"), false);
  assert.equal(JSON.stringify(workQueueBody).includes("methotrexate"), false);

  const wrongReviewCredential = await fetch(`${baseUrl}/v1/cases/${caseId}/review-context`, {
    headers: { authorization: `Bearer ${operationsToken}` }
  });
  assert.equal(wrongReviewCredential.status, 401);

  const review = await fetch(`${baseUrl}/v1/cases/${caseId}/review-context`, {
    headers: { authorization: `Bearer ${reviewToken}` }
  });
  assert.equal(review.status, 200);
  assert.equal(review.headers.get("cache-control"), "no-store");
  const reviewBody = await review.json();
  assert.equal(reviewBody.patientReference, "Patient/synthetic-001");
  assert.ok(reviewBody.paDraft?.evidence?.length > 0);

  const reviewEtag = review.headers.get("etag");
  assert.ok(reviewEtag);
  const claim = await fetch(`${baseUrl}/v1/cases/${caseId}/review-claim`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${reviewToken}`,
      "if-match": reviewEtag
    },
    body: JSON.stringify({ reviewer: "spoofed-claim-reviewer", leaseSeconds: 300 })
  });
  assert.equal(claim.status, 200);
  const claimBody = await claim.json();
  assert.equal(claimBody.reviewOwner, reviewPrincipal);
  const claimEtag = claim.headers.get("etag");
  assert.ok(claimEtag);

  const approval = await fetch(`${baseUrl}/v1/cases/${caseId}/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${reviewToken}`,
      "if-match": claimEtag,
      "x-idempotency-key": "http-review-decision-0001"
    },
    body: JSON.stringify({
      reviewer: "spoofed-body-reviewer",
      finalAnswer: "Reviewer-confirmed answer from the synthetic chart evidence."
    })
  });
  assert.equal(approval.status, 200);
  assert.equal(approval.headers.get("cache-control"), "no-store");
  const approvalBody = await approval.json();
  assert.equal(approvalBody.status, "ROUTED");
  assert.equal(JSON.stringify(approvalBody).includes("Reviewer-confirmed answer"), false);

  const approvalReplay = await fetch(`${baseUrl}/v1/cases/${caseId}/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${reviewToken}`,
      "if-match": claimEtag,
      "x-idempotency-key": "http-review-decision-0001"
    },
    body: JSON.stringify({ finalAnswer: "Reviewer-confirmed answer from the synthetic chart evidence." })
  });
  assert.equal(approvalReplay.status, 200);
  const replayBody = await approvalReplay.json();
  assert.equal(replayBody.version, approvalBody.version);

  const approvalConflict = await fetch(`${baseUrl}/v1/cases/${caseId}/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${reviewToken}`,
      "if-match": claimEtag,
      "x-idempotency-key": "http-review-decision-0001"
    },
    body: JSON.stringify({ finalAnswer: "Conflicting synthetic retry answer." })
  });
  assert.equal(approvalConflict.status, 409);

  const queueAfterApproval = await fetch(`${baseUrl}/v1/work-queue`, { headers: { authorization: `Bearer ${operationsToken}` } });
  assert.equal(queueAfterApproval.status, 200);
  const queueAfterApprovalBody = await queueAfterApproval.json();
  assert.equal(queueAfterApprovalBody.items.some((item) => item.caseId === caseId), false);
  assert.ok(queueAfterApprovalBody.items.some((item) => item.caseId === taskBody.case.id));

  const lowConfidenceFixture = JSON.parse(JSON.stringify(fixture));
  lowConfidenceFixture.id = "rx-http-two-person";
  lowConfidenceFixture.note = [{ text: "Initial treatment request." }];
  const twoPersonIngest = await fetch(`${baseUrl}/v1/fhir/MedicationRequest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ingestToken}`,
      "x-idempotency-key": "http-two-person-ingest"
    },
    body: JSON.stringify(lowConfidenceFixture)
  });
  assert.equal(twoPersonIngest.status, 201);
  const twoPersonBody = await twoPersonIngest.json();
  const twoPersonCaseId = twoPersonBody.case.id;

  const twoPersonContext = await fetch(`${baseUrl}/v1/cases/${twoPersonCaseId}/review-context`, {
    headers: { authorization: `Bearer ${reviewToken}` }
  });
  assert.equal(twoPersonContext.status, 200);
  const twoPersonContextBody = await twoPersonContext.json();
  assert.equal(twoPersonContextBody.paDraft.confidence, 0.55);
  const twoPersonContextEtag = twoPersonContext.headers.get("etag");
  assert.ok(twoPersonContextEtag);

  const firstTwoPersonClaim = await fetch(`${baseUrl}/v1/cases/${twoPersonCaseId}/review-claim`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${reviewToken}`,
      "if-match": twoPersonContextEtag
    },
    body: JSON.stringify({ leaseSeconds: 300 })
  });
  assert.equal(firstTwoPersonClaim.status, 200);
  const firstTwoPersonClaimEtag = firstTwoPersonClaim.headers.get("etag");
  assert.ok(firstTwoPersonClaimEtag);

  const firstTwoPersonDecision = await fetch(`${baseUrl}/v1/cases/${twoPersonCaseId}/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${reviewToken}`,
      "if-match": firstTwoPersonClaimEtag,
      "x-idempotency-key": "http-two-person-decision-a"
    },
    body: JSON.stringify({ finalAnswer: "First reviewer synthetic override." })
  });
  assert.equal(firstTwoPersonDecision.status, 200);
  const firstTwoPersonDecisionBody = await firstTwoPersonDecision.json();
  assert.equal(firstTwoPersonDecisionBody.status, "SECOND_APPROVAL_REQUIRED");
  const firstTwoPersonDecisionEtag = firstTwoPersonDecision.headers.get("etag");
  assert.ok(firstTwoPersonDecisionEtag);

  const escalationContext = await fetch(`${baseUrl}/v1/cases/${twoPersonCaseId}/review-context`, {
    headers: { authorization: `Bearer ${secondReviewToken}` }
  });
  assert.equal(escalationContext.status, 200);
  const escalationBody = await escalationContext.json();
  assert.equal(escalationBody.status, "SECOND_APPROVAL_REQUIRED");
  assert.equal(escalationBody.firstReviewer, reviewPrincipal);
  assert.equal(escalationBody.proposedOverride, "First reviewer synthetic override.");
  assert.equal(escalationBody.reviewReceipts.length, 1);

  const queueDuringEscalation = await fetch(`${baseUrl}/v1/work-queue`, { headers: { authorization: `Bearer ${operationsToken}` } });
  assert.equal(queueDuringEscalation.status, 200);
  const queueDuringEscalationBody = await queueDuringEscalation.json();
  const escalationItem = queueDuringEscalationBody.items.find((item) => item.caseId === twoPersonCaseId);
  assert.equal(escalationItem?.action, "SECOND_PHARMACIST_APPROVAL");
  assert.equal(JSON.stringify(escalationItem).includes("First reviewer synthetic override"), false);

  const secondClaim = await fetch(`${baseUrl}/v1/cases/${twoPersonCaseId}/review-claim`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secondReviewToken}`,
      "if-match": firstTwoPersonDecisionEtag
    },
    body: JSON.stringify({ leaseSeconds: 300 })
  });
  assert.equal(secondClaim.status, 200);
  const secondClaimEtag = secondClaim.headers.get("etag");
  assert.ok(secondClaimEtag);

  const selfSecondApproval = await fetch(`${baseUrl}/v1/cases/${twoPersonCaseId}/second-approve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${reviewToken}`,
      "if-match": secondClaimEtag,
      "x-idempotency-key": "http-two-person-self"
    },
    body: JSON.stringify({})
  });
  assert.equal(selfSecondApproval.status, 409);

  const secondApproval = await fetch(`${baseUrl}/v1/cases/${twoPersonCaseId}/second-approve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secondReviewToken}`,
      "if-match": secondClaimEtag,
      "x-idempotency-key": "http-two-person-decision-b"
    },
    body: JSON.stringify({})
  });
  assert.equal(secondApproval.status, 200);
  const secondApprovalBody = await secondApproval.json();
  assert.equal(secondApprovalBody.status, "ROUTED");
  assert.equal(secondApprovalBody.reviewReceiptCount, 2);

  const dlq = await fetch(`${baseUrl}/v1/outbox/dead-letter`, { headers: { authorization: `Bearer ${operationsToken}` } });
  assert.equal(dlq.status, 200);
  const dlqBody = await dlq.json();
  assert.equal(dlqBody.events.length, 0);

  const tenantMetricsDenied = await fetch(`${baseUrl}/metrics`, { headers: { authorization: `Bearer ${operationsToken}` } });
  assert.equal(tenantMetricsDenied.status, 401);
  const platformMetrics = await fetch(`${baseUrl}/metrics`, { headers: { authorization: `Bearer ${platformToken}` } });
  assert.equal(platformMetrics.status, 200);

  const ready = await fetch(`${baseUrl}/health/ready`);
  assert.equal(ready.status, 200);
  const readyBody = await ready.json();
  assert.equal(readyBody.storage, "ok");
  assert.equal("pendingOutbox" in readyBody, false);
  assert.equal("deadLetterOutbox" in readyBody, false);

  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT case_json FROM cases WHERE id = ?").get(caseId);
    const durable = JSON.parse(row.case_json);
    const approvalAudit = durable.audit.find((entry) => entry.type === "pa_approved");
    assert.equal(approvalAudit?.details?.reviewer, reviewPrincipal);
    assert.equal(approvalAudit?.details?.edited, true);
    assert.equal(durable.reviewDecision?.reviewer, reviewPrincipal);
    assert.equal(durable.reviewDecision?.edited, true);
    assert.equal(durable.reviewDecision?.finalAnswer, "Reviewer-confirmed answer from the synthetic chart evidence.");
    assert.equal(durable.paDraft?.answer === durable.reviewDecision?.finalAnswer, false);
    assert.equal(durable.version, 5);
  } finally {
    db.close();
  }

  console.log(JSON.stringify({
    httpSmoke: "ok",
    unauthenticatedIngest: 401,
    authenticatedIngest: 201,
    secondTenantIngest: 201,
    crossTenantRead: 404,
    crossTenantReview: 404,
    wrongReviewCredential: 401,
    taskBundleIngest: 201,
    workQueue: 200,
    reviewerContext: 200,
    reviewClaim: 200,
    approval: 200,
    approvalReplay: 200,
    approvalConflict: 409,
    twoPersonFirstDecision: "SECOND_APPROVAL_REQUIRED",
    twoPersonSelfApproval: 409,
    twoPersonSecondApproval: 200,
    finalStatus: "ROUTED",
    durableReviewer: reviewPrincipal,
    reviewerEditedDraft: true,
    taskWorkflowSource: "FHIR_TASK",
    tenantIsolation: "ok",
    platformMetrics: 200,
    readiness: "ok",
    securityHeaders: "ok"
  }));
} finally {
  await shutdown();
  await unlink(dbPath).catch(() => undefined);
}
