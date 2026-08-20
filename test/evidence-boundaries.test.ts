import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { findForbiddenPositiveClaims, type EvidenceRegistry } from "../src/evidence-boundaries.js";

const repositoryRoot = new URL("../../", import.meta.url);

async function readRegistry(): Promise<EvidenceRegistry> {
  return JSON.parse(await readFile(new URL("docs/evidence-boundaries.json", repositoryRoot), "utf8")) as EvidenceRegistry;
}

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

test("evidence registry distinguishes observed CI, local, and reference-only states", async () => {
  const registry = await readRegistry();
  assert.equal(registry.releaseVersion, "0.9.0");
  assert.equal(registry.evidenceStatus.syntheticFHIRWorkflow, "executed-in-ci");
  assert.equal(registry.evidenceStatus.sqliteProcessConcurrency, "executed-local");
  assert.equal(registry.evidenceStatus.postgresAdapter, "executed-in-ci");
  assert.equal(registry.evidenceStatus.postgres17CiScenario, "executed-in-ci");
  assert.equal(registry.evidenceStatus.containerRuntime, "executed-in-ci");
  assert.equal(registry.evidenceStatus.supplyChainAudit, "executed-in-ci");
  assert.equal(registry.evidenceStatus.terraformValidation, "executed-in-ci");
  assert.equal(registry.evidenceStatus.workflowGovernanceCoverage, "executed-in-ci");
  assert.equal(registry.evidenceStatus.outboxReliabilityCoverage, "executed-in-ci");
  assert.equal(registry.evidenceStatus.cloudRunCloudSqlPubSub, "reference-only");
  assert.equal(registry.evidenceStatus.epic, "not-integrated");
  assert.equal(registry.evidenceStatus.realPatientData, "none");
});

test("machine-readable public claims stay inside the evidence boundary", async () => {
  const registry = await readRegistry();
  const violations = findForbiddenPositiveClaims((registry.publicClaims ?? []).join("\n"), registry.forbiddenPositiveClaims ?? []);
  assert.deepEqual(violations, []);
});
