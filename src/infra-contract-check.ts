import { readFileSync } from "node:fs";
import { VERSION } from "./version.js";

const terraform = readFileSync("infra/gcp/main.tf", "utf8");
const variables = readFileSync("infra/gcp/variables.tf", "utf8");
const dockerfile = readFileSync("Dockerfile", "utf8");
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  version?: string;
  dependencies?: Record<string, string>;
};

const requiredTerraform = [
  "google_sql_database_instance",
  "POSTGRES_17",
  "google_cloud_run_v2_service",
  "google_cloud_run_v2_job",
  "google_pubsub_topic",
  "roles/cloudsql.client"
];
for (const marker of requiredTerraform) {
  if (!terraform.includes(marker)) throw new Error(`infra_contract_missing:${marker}`);
}

for (const marker of [
  "worker_min_instances",
  "worker_publish_interval_ms",
  "worker_per_tenant_claim_limit",
  "worker_tenant_delivery_concurrency",
  "outbox_pending_age_target_ms"
]) {
  if (!variables.includes(marker)) throw new Error(`infra_variable_missing:${marker}`);
}

if (!dockerfile.includes("npm ci --omit=dev")) throw new Error("docker_runtime_install_not_locked");
if (!ci.includes("postgres:17") || !ci.includes("test:postgres:live")) {
  throw new Error("postgres_live_ci_contract_missing");
}
if (packageJson.version !== VERSION) throw new Error("infra_package_version_mismatch");
if (packageJson.dependencies?.pg !== "8.16.3") throw new Error("postgres_dependency_not_pinned");

console.log(JSON.stringify({
  infrastructureContract: "ok",
  version: VERSION,
  postgres17Reference: true,
  cloudRunReference: true,
  pubsubReference: true,
  dockerInstall: "npm_ci",
  liveDeploymentClaim: false
}, null, 2));
