import { readFile } from "node:fs/promises";
import { VERSION } from "./version.js";

const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const required: Array<[string, string]> = [
  ["npm run release:check", "local_release_gate"],
  ["npm ci --ignore-scripts --no-audit --no-fund", "deterministic_dependency_install"],
  ["postgres:17", "postgres_17_service"],
  ["npm run test:postgres:live", "postgres_live_gate"],
  ["actions/upload-artifact@v4", "evidence_artifact_upload"],
  ["docs/release-evidence-*.json", "local_release_evidence_artifact"],
  ["artifacts/postgres-live-evidence.json", "postgres_live_evidence_artifact"]
];
for (const [needle, label] of required) {
  if (!workflow.includes(needle)) throw new Error(`ci_contract_missing:${label}`);
}
const artifactUploadCount = workflow.split("actions/upload-artifact@v4").length - 1;
if (artifactUploadCount < 2) throw new Error("ci_contract_requires_two_evidence_uploads");

console.log(JSON.stringify({
  ciContract: "ok",
  version: VERSION,
  postgresService: 17,
  evidenceArtifactUploads: artifactUploadCount,
  localReleaseEvidence: true,
  postgresLiveEvidence: true,
  deterministicInstall: "npm_ci"
}));
