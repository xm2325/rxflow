import { createHash, randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext } from "@playwright/test";

const reviewToken = "synthetic-review-token-0000000000001";
const backendBase = "http://127.0.0.1:8080";

function paRequiredCode(plan: string): string {
  for (let i = 0; i < 10_000; i += 1) {
    const code = `boundary-med-${i}`;
    if (createHash("sha256").update(`${plan}|${code}`).digest()[0] % 2 === 0) return code;
  }
  throw new Error("unable_to_find_pa_code");
}

async function seed(api: APIRequestContext): Promise<string> {
  const id = `rx-${randomUUID()}`;
  const plan = "BOUNDARY_PLAN";
  const code = paRequiredCode(plan);
  const response = await api.post("/v1/fhir/MedicationRequest", {
    headers: { "content-type": "application/json", "x-idempotency-key": `boundary-${id}` },
    data: {
      resourceType: "MedicationRequest",
      id,
      subject: { reference: "Patient/synthetic-boundary" },
      medicationCodeableConcept: { coding: [{ code }] },
      insurance: [{ display: plan }],
      note: [{ text: "Prior therapy trial of methotrexate." }]
    }
  });
  expect(response.ok()).toBeTruthy();
  return code;
}

test("stale review response clears the optimistic-concurrency guard", async ({ page }) => {
  const api = await request.newContext({ baseURL: backendBase });
  const code = await seed(api);
  await api.dispose();

  await page.goto("/");
  await page.getByLabel("Synthetic reviewer bearer token").fill(reviewToken);
  await page.getByRole("button", { name: "Refresh queue" }).click();
  await page.getByLabel("Filter queue").fill(code);
  const row = page.getByRole("row").filter({ hasText: code });
  await row.getByRole("button", { name: "Review" }).click();
  await expect(page.getByText("Review context loaded with optimistic-concurrency guard.")).toBeVisible();

  await page.route("**/api/v1/cases/*/approve", async (route) => {
    await route.fulfill({
      status: 412,
      contentType: "application/json",
      body: JSON.stringify({ errors: [{ code: "stale_review" }] })
    });
  });
  await page.getByRole("button", { name: "Approve and route" }).click();
  await expect(page.getByText("This case changed after it was loaded. Reload the case before deciding again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and route" })).toBeDisabled();
});

test("proxy rejects routes outside the review allow-list", async ({ request: browserRequest }) => {
  const response = await browserRequest.get("/api/v1/not-allowed");
  expect(response.status()).toBe(404);
  const body = await response.json();
  expect(body.errors?.[0]?.code).toBe("review_proxy_route_not_allowed");
});

test("review surface emits restrictive response headers", async ({ request: browserRequest }) => {
  const response = await browserRequest.get("/");
  expect(response.status()).toBe(200);
  const headers = response.headers();
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["cache-control"]).toContain("no-store");
});
