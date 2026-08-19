import test from "node:test";
import assert from "node:assert/strict";
import { buildEvidenceEnvelope, parseCoverageSummary, parseTestSummary } from "../src/release-evidence.js";

test("parseTestSummary reads the Node TAP summary", () => {
  const summary = parseTestSummary(`# tests 258\n# pass 258\n# fail 0\n`);
  assert.deepEqual(summary, { total: 258, passed: 258, failed: 0 });
});

test("parseCoverageSummary reads all-file source coverage", () => {
  const output = `
# start of coverage report
# ------------------------------------------------------------------------------
# file             | line % | branch % | funcs % | uncovered lines
# ------------------------------------------------------------------------------
# all files        |  93.04 |    77.10 |   90.43 |
# src              |  91.00 |    75.00 |   88.00 |
# ------------------------------------------------------------------------------
# end of coverage report`;
  assert.deepEqual(parseCoverageSummary(output), { lines: 93.04, branches: 77.10, functions: 90.43 });
});

test("parsers reject incomplete release output", () => {
  assert.throws(() => parseTestSummary("# tests 258\n# pass 257"), /test_summary_missing:failed/);
  assert.throws(() => parseCoverageSummary("all files | -- | -- | --"), /coverage_summary_missing/);
});

test("buildEvidenceEnvelope keeps evidence limitations explicit", () => {
  const evidence = buildEvidenceEnvelope({
    version: "0.4.7",
    startedAt: "2026-08-19T12:00:00.000Z",
    finishedAt: "2026-08-19T12:00:30.000Z",
    tests: { total: 258, passed: 258, failed: 0, coverage: { lines: 93.04, branches: 77.10, functions: 90.43 } },
    steps: [{ name: "tests + core coverage", durationMs: 1234, evidence: { coverage: true } }],
    environment: { postgresClient: null, docker: null, terraform: null, livePostgresUrlConfigured: false }
  });
  assert.equal(evidence.syntheticDataOnly, true);
  assert.equal(evidence.livePostgresVerified, false);
  assert.equal(evidence.liveCloudDeploymentVerified, false);
  assert.equal(evidence.productionPerformanceBenchmark, false);
});
