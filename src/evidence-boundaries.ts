export interface EvidenceRegistry {
  schemaVersion: number;
  releaseVersion: string;
  evidenceStatus: Record<string, string>;
  forbiddenPositiveClaims: string[];
  publicClaims: string[];
}

export function findForbiddenPositiveClaims(text: string, phrases: string[]): string[] {
  const normalized = text.toLowerCase();
  return phrases.filter((phrase) => normalized.includes(phrase.toLowerCase()));
}

export function validateEvidenceStatuses(registry: EvidenceRegistry): void {
  const expected: Record<string, string> = {
    syntheticFHIRWorkflow: "executed-in-ci",
    sqliteProcessConcurrency: "executed-local",
    postgresAdapter: "executed-in-ci",
    postgres17CiScenario: "executed-in-ci",
    postgresReviewGovernance: "executed-in-ci",
    containerRuntime: "executed-in-ci",
    supplyChainAudit: "executed-in-ci",
    terraformValidation: "executed-in-ci",
    workflowGovernanceCoverage: "executed-in-ci",
    outboxReliabilityCoverage: "executed-in-ci",
    cloudRunCloudSqlPubSub: "reference-only",
    epic: "not-integrated",
    surescripts: "not-integrated",
    realPatientData: "none",
    clinicalDeployment: "none",
    complianceCertification: "none",
    typescriptBuildTool: "locked-dev-dependency"
  };
  for (const [name, status] of Object.entries(expected)) {
    if (registry.evidenceStatus[name] !== status) throw new Error(`evidence_status_mismatch:${name}`);
  }
}
