import { createHash, randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext } from "@playwright/test";

const reviewToken = "synthetic-review-token-0000000000001";
const backendBase = "http://127.0.0.1:8080";

function paRequiredCode(plan: string): string {
  for (let i = 0; i < 10_000; i += 1) {
    const code = `synthetic-med-${i}`;
    const firstByte = createHash("sha256").update(`${plan}|${code}`).digest()[0];
    if (firstByte % 2 === 0) return code;
  }
  throw new Error("unable_to_find_deterministic_pa_code");
}

async function seedReviewCase(api: APIRequestContext): Promise<{ id: string; code: string }> {
  const id = `rx-${randomUUID()}`;
  const plan = "SYNTHETIC_REVIEW_PLAN";
  const code = paRequiredCode(plan);
  const response = await api.post("/v1/fhir/MedicationRequest", {
    headers: {
      "content-type": "application/fhir+json",
      "x-idempotency-key": `seed-${id}`,
      "x-correlation-id": `corr-${id}`
    },
    data: {
      resourceType: "MedicationRequest",
      id,
      subject: { reference: "Patient/synthetic-review" },
      medicationCodeableConcept: { coding: [{ code }] },
      insurance: [{ display: plan }],
      note: [{ text: "Prior therapy trial of methotrexate is documented in this synthetic case." }]
    }
  });
  expect(response.ok()).toBeTruthy();
  return { id, code };
}

test("reviewer can move a synthetic case from queue to approved routing", async ({ page }) => {
  const api = await request.newContext({ baseURL: backendBase });
  const seeded = await seedReviewCase(api);
  await api.dispose();

  await page.goto("/");
  await page.getByLabel("Synthetic reviewer bearer token").fill(reviewToken);
  await page.getByRole("button", { name: "Refresh queue" }).click();
  await page.getByLabel("Filter queue").fill(seeded.code);

  const row = page.getByRole("row").filter({ hasText: seeded.code });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Review" }).click();
  await expect(page.getByText("Review context loaded with optimistic-concurrency guard.")).toBeVisible();

  const answer = page.getByLabel("Final reviewed answer");
  const original = await answer.inputValue();
  expect(original.length).toBeGreaterThan(4);
  await answer.fill(`${original} Reviewed in the synthetic console.`);
  await page.getByRole("button", { name: "Approve and route" }).click();

  await expect(page.getByText("Synthetic review decision committed and routing transition accepted.")).toBeVisible();
  await page.getByRole("button", { name: "Refresh queue" }).click();
  await page.getByLabel("Filter queue").fill(seeded.code);
  await expect(page.getByText("No matching actionable cases.")).toBeVisible();
});

test("bearer credential remains in page memory rather than local storage", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Synthetic reviewer bearer token").fill(reviewToken);
  const storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }));
  expect(storage).toEqual({ local: 0, session: 0 });
});
