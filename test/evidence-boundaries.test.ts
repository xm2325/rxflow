import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { findForbiddenPositiveClaims, type EvidenceRegistry } from "../src/evidence-boundaries.js";

test("forbidden positive deployment claims are detected", () => {
  const violations = findForbiddenPositiveClaims(
    "RxFlow is deployed to GCP with production PostgreSQL.",
    ["deployed to GCP", "production PostgreSQL"]
  );
  assert.deepEqual(violations, ["deployed to GCP", "production PostgreSQL"]);
});

test("forbidden positive EHR integration claims are detected", () => {
  assert.deepEqual(findForbiddenPositiveClaims(
    "The system includes Epic integration.",
    ["Epic integration", "Surescripts integration"]
  ), ["Epic integration"]);
});

test("evidence registry separates local, implemented, and reference-only states", async () => {
  const registry = JSON.parse(await readFile(new URL("../docs/evidence-boundaries.json", import.meta.url), "utf8")) as EvidenceRegistry;
  assert.equal(registry.evidenceStatus.syntheticFHIRWorkflow, "executed-local");
  assert.equal(registry.evidenceStatus.postgresAdapter, "implemented-not-live-here");
  assert.equal(registry.evidenceStatus.cloudRunCloudSqlPubSub, "reference-only");
  assert.equal(registry.evidenceStatus.epic, "not-integrated");
  assert.equal(registry.evidenceStatus.realPatientData, "none");
});

test("machine-readable public claims stay inside the evidence boundary", async () => {
  const registry = JSON.parse(await readFile(new URL("../docs/evidence-boundaries.json", import.meta.url), "utf8")) as EvidenceRegistry;
  const violations = findForbiddenPositiveClaims((registry.publicClaims ?? []).join("\n"), registry.forbiddenPositiveClaims ?? []);
  assert.deepEqual(violations, []);
});
