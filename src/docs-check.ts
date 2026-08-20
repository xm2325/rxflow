import { readFile } from "node:fs/promises";
import { VERSION } from "./version.js";

interface PackageManifest { version?: string; }
interface ReleaseEvidence {
  version?: string;
  tests?: { tests?: number; pass?: number; fail?: number };
  coverage?: { lines?: number; branches?: number; functions?: number };
  gates?: Array<{ name?: string; status?: string }>;
}

const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as PackageManifest;
if (packageJson.version !== VERSION) {
  throw new Error(`release_version_mismatch:package=${packageJson.version ?? "missing"}:runtime=${VERSION}`);
}

const evidenceUrl = new URL(`../../docs/release-evidence-v${VERSION}.json`, import.meta.url);
let evidence: ReleaseEvidence;
try {
  evidence = JSON.parse(await readFile(evidenceUrl, "utf8")) as ReleaseEvidence;
} catch {
  throw new Error("release_evidence_missing_or_invalid");
}
if (evidence.version !== VERSION) throw new Error(`release_evidence_version_mismatch:${evidence.version ?? "missing"}`);
const tests = evidence.tests;
if (!tests || tests.tests !== tests.pass || tests.fail !== 0 || !Number.isInteger(tests.tests) || (tests.tests ?? 0) <= 0) {
  throw new Error("release_evidence_tests_invalid");
}
const coverage = evidence.coverage;
if (!coverage || typeof coverage.lines !== "number" || typeof coverage.branches !== "number" || typeof coverage.functions !== "number") {
  throw new Error("release_evidence_coverage_invalid");
}
const coverageLines = coverage.lines;
const coverageBranches = coverage.branches;
const coverageFunctions = coverage.functions;
const failedGate = evidence.gates?.find((gate) => gate.status !== "PASS");
if (failedGate) throw new Error(`release_evidence_gate_not_passed:${failedGate.name ?? "unknown"}`);

const checks: Array<[URL, string, string]> = [
  [new URL("../../README.md", import.meta.url), `## Current release: v${VERSION}`, "readme_current_release"],
  [new URL("../../README.md", import.meta.url), `${tests.tests}-test core suite`, "readme_test_count"],
  [new URL("../../docs/architecture.md", import.meta.url), `# RxFlow v${VERSION} architecture`, "architecture_release"],
  [new URL(`../../docs/run-report-v${VERSION}.md`, import.meta.url), `# RxFlow v${VERSION} run report`, "run_report_release"],
  [new URL(`../../docs/run-report-v${VERSION}.md`, import.meta.url), `${tests.tests} / ${tests.tests}`, "run_report_test_count"],
  [new URL(`../../docs/run-report-v${VERSION}.md`, import.meta.url), `lines      ${coverageLines.toFixed(2)}%`, "run_report_line_coverage"],
  [new URL(`../../docs/run-report-v${VERSION}.md`, import.meta.url), `branches   ${coverageBranches.toFixed(2)}%`, "run_report_branch_coverage"],
  [new URL(`../../docs/run-report-v${VERSION}.md`, import.meta.url), `functions  ${coverageFunctions.toFixed(2)}%`, "run_report_function_coverage"],
  [new URL("../../docs/portfolio.html", import.meta.url), `RxFlow v${VERSION}`, "portfolio_release"],
  [new URL("../../docs/index.html", import.meta.url), `RxFlow v${VERSION}`, "index_release"],
  [new URL("../../docs/portfolio.html", import.meta.url), `${tests.tests}`, "portfolio_test_count"],
  [new URL("../../docs/quality-gate.md", import.meta.url), `# RxFlow v${VERSION} source quality gate`, "quality_gate_release"],
  [new URL("../../docs/quality-gate.md", import.meta.url), `lines: 90%`, "quality_gate_line_threshold"],
  [new URL("../../docs/quality-gate.md", import.meta.url), `branches: 75%`, "quality_gate_branch_threshold"],
  [new URL("../../docs/quality-gate.md", import.meta.url), `functions: 85%`, "quality_gate_function_threshold"],
  [new URL("../../docs/project-evidence.md", import.meta.url), `# RxFlow v${VERSION} project evidence`, "project_evidence_release"],
  [new URL("../../docs/evidence-boundaries.json", import.meta.url), `"releaseVersion": "${VERSION}"`, "evidence_registry_release"],
  [new URL("../../docs/github-publish-checklist.md", import.meta.url), `# RxFlow v${VERSION} — GitHub publication checklist`, "github_publish_checklist_release"],
  [new URL("../../docs/public-repository-surface.md", import.meta.url), `# RxFlow v${VERSION} public repository surface`, "public_repository_surface_release"]
];

for (const [url, required, name] of checks) {
  let text: string;
  try {
    text = await readFile(url, "utf8");
  } catch {
    throw new Error(`release_docs_missing:${name}`);
  }
  if (!text.includes(required)) throw new Error(`release_docs_stale:${name}`);
}

console.log(JSON.stringify({
  releaseDocs: "ok",
  version: VERSION,
  checked: checks.length + 2,
  evidenceTests: tests.tests,
  evidenceCoverage: { lines: coverageLines, branches: coverageBranches, functions: coverageFunctions },
  evidenceGates: evidence.gates?.length ?? 0
}));
