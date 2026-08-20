export interface TestSummary {
  tests: number;
  pass: number;
  fail: number;
  durationMs: number;
}

export interface CoverageSummary {
  lines: number;
  branches: number;
  functions: number;
}

export interface CompactTestSummary {
  total: number;
  passed: number;
  failed: number;
}

export interface EvidenceEnvelopeInput {
  version: string;
  startedAt: string;
  finishedAt: string;
  tests: CompactTestSummary & { coverage?: CoverageSummary };
  steps: Array<Record<string, unknown>>;
  environment: {
    postgresClient: string | null;
    docker: string | null;
    terraform: string | null;
    livePostgresUrlConfigured: boolean;
    [key: string]: unknown;
  };
}

export function parseTestSummary(text: string): CompactTestSummary {
  const read = (label: "tests" | "pass" | "fail", output: "total" | "passed" | "failed"): [string, number] => {
    const match = text.match(new RegExp(`^# ${label}\\s+(\\d+)$`, "m"));
    if (!match) throw new Error(`test_summary_missing:${output}`);
    return [output, Number(match[1])];
  };
  return Object.fromEntries([read("tests", "total"), read("pass", "passed"), read("fail", "failed")]) as unknown as CompactTestSummary;
}

export function buildEvidenceEnvelope(input: EvidenceEnvelopeInput): EvidenceEnvelopeInput & {
  syntheticDataOnly: true;
  livePostgresVerified: boolean;
  liveCloudDeploymentVerified: false;
  productionPerformanceBenchmark: false;
} {
  return {
    ...input,
    syntheticDataOnly: true,
    livePostgresVerified: Boolean(input.environment.livePostgresUrlConfigured),
    liveCloudDeploymentVerified: false,
    productionPerformanceBenchmark: false
  };
}

function requireMatch(text: string, pattern: RegExp, label: string): RegExpMatchArray {
  const match = text.match(pattern);
  if (!match) throw new Error(`release_evidence_missing_${label}`);
  return match;
}

export function parseNodeTestSummary(text: string): TestSummary {
  const tests = Number(requireMatch(text, /^# tests\s+(\d+)$/m, "tests")[1]);
  const pass = Number(requireMatch(text, /^# pass\s+(\d+)$/m, "pass")[1]);
  const fail = Number(requireMatch(text, /^# fail\s+(\d+)$/m, "fail")[1]);
  const durationMs = Number(requireMatch(text, /^# duration_ms\s+([0-9.]+)$/m, "duration")[1]);
  if (![tests, pass, fail, durationMs].every(Number.isFinite)) throw new Error("release_evidence_invalid_test_summary");
  return { tests, pass, fail, durationMs };
}

export function parseCoverageSummary(text: string): CoverageSummary {
  const match = text.match(/^# all files\s+\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|/m);
  if (!match) throw new Error("coverage_summary_missing");
  const summary = {
    lines: Number(match[1]),
    branches: Number(match[2]),
    functions: Number(match[3])
  };
  if (!Object.values(summary).every(Number.isFinite)) throw new Error("release_evidence_invalid_coverage_summary");
  return summary;
}

export function parseLastJsonValue(text: string): unknown {
  const values: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try { values.push(JSON.parse(text.slice(start, index + 1))); }
        catch { /* Ignore non-JSON brace groups and keep scanning. */ }
        start = -1;
      }
    }
  }
  if (values.length === 0) throw new Error("release_evidence_json_summary_missing");
  return values[values.length - 1];
}
