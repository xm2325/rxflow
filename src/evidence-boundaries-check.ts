import { readFile } from "node:fs/promises";
import { VERSION } from "./version.js";
import { findForbiddenPositiveClaims, validateEvidenceStatuses, type EvidenceRegistry } from "./evidence-boundaries.js";

const registry = JSON.parse(await readFile(new URL("../../docs/evidence-boundaries.json", import.meta.url), "utf8")) as EvidenceRegistry;
if (registry.schemaVersion !== 1) throw new Error("evidence_registry_schema_mismatch");
if (registry.releaseVersion !== VERSION) throw new Error("evidence_registry_version_mismatch");
validateEvidenceStatuses(registry);

const publicClaimText = registry.publicClaims.join("\n");
const hits = findForbiddenPositiveClaims(publicClaimText, registry.forbiddenPositiveClaims);
if (hits.length) throw new Error(`evidence_boundary_overclaim:${hits.join("|")}`);

const projectEvidence = await readFile(new URL("../../docs/project-evidence.md", import.meta.url), "utf8");
for (const required of ["Epic and Surescripts are not integrated", "no real patient data", "reference target, not an observed deployment"]) {
  if (!projectEvidence.includes(required)) throw new Error(`evidence_boundary_required_limit_missing:${required}`);
}

console.log(JSON.stringify({
  evidenceBoundaries: "ok",
  version: VERSION,
  evidenceStatuses: registry.evidenceStatus,
  checkedSurfaces: ["machine-readable public claims", "project evidence limits"],
  forbiddenPositiveClaimCount: registry.forbiddenPositiveClaims.length
}, null, 2));
