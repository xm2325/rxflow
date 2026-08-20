import { createHash, randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext } from "@playwright/test";

const reviewToken = "synthetic-review-token-0000000000001";
const backendBase = "http://127.0.0.1:8080";

function paRequiredCode(plan: string): string {
  for (let i = 0; i < 10_000; i += 1) {
    const code = `idem-e2e-med-${i}`;
    if (createHash("sha256").update(`${plan}|${code}`).digest()[0] % 2 === 0) return code;
  }
  throw new Error("unable_to_find_pa_code");
}

async function seed(api: APIRequestContext) {
  const id = `rx-${randomUUID()}`;
  const plan = "IDEMPOTENCY_E2E_PLAN";
  const code = paRequiredCode(plan);
  const response = await api.post("/v1/fhir/MedicationRequest", {
    headers: { "content-type": "application/json", "x-idempotency-key": `seed-${id}` },
    data: {
      resourceType: "MedicationRequest",
      id,
      subject: { reference: "Patient/synthetic-idempotency-e2e" },
      medicationCodeableConcept: { coding: [{ code }] },
      insurance: [{ display: plan }],
      note: [{ text: "Prior therapy trial of methotrexate." }]
    }
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  return { caseId: body.case?.id ?? body.id, version: body.case?.version ?? body.version };
}

test("approval retry with the same decision key returns the committed winner", async () => {
  const api = await request.newContext({ baseURL: backendBase });
  const seeded = await seed(api);
  const context = await api.get(`/v1/cases/${seeded.caseId}/review-context`, {
    headers: { authorization: `Bearer ${reviewToken}` }
  });
  expect(context.ok()).toBeTruthy();
  const etag = context.headers()["etag"];
  const contextBody = await context.json();
  const answer = `${contextBody.paDraft?.answer ?? contextBody.draft?.answer ?? "Synthetic answer"} Reviewed.`;
  const key = `decision-${randomUUID()}`;
  const headers = {
    authorization: `Bearer ${reviewToken}`,
    "content-type": "application/json",
    "if-match": etag,
    "x-idempotency-key": key
  };
  const payload = { reviewer: "synthetic-reviewer", finalAnswer: answer };
  const first = await api.post(`/v1/cases/${seeded.caseId}/approve`, { headers, data: payload });
  expect(first.status()).toBe(200);
  const firstBody = await first.json();

  const replay = await api.post(`/v1/cases/${seeded.caseId}/approve`, { headers, data: payload });
  expect(replay.status()).toBe(200);
  const replayBody = await replay.json();
  expect(replayBody.id).toBe(firstBody.id);
  expect(replayBody.version).toBe(firstBody.version);

  const conflict = await api.post(`/v1/cases/${seeded.caseId}/approve`, {
    headers,
    data: { reviewer: "synthetic-reviewer", finalAnswer: `${answer} changed` }
  });
  expect(conflict.status()).toBe(409);
  const conflictBody = await conflict.json();
  expect(conflictBody.errors?.[0]?.code).toBe("review_idempotency_key_conflict");
  await api.dispose();
});
