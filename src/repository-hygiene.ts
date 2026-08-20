import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export function staleGeneratedEvidence(paths: string[], version: string): string[] {
  const generated = /^(run-report-v.+\.md|release-evidence-v.+\.json)$/;
  return paths.filter((path) => generated.test(path) && !path.includes(`v${version}`));
}

export function findSecretLikeTokens(text: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ["github_token", /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}\b/],
    ["google_api_key", /\bAIza[0-9A-Za-z_-]{20,}\b/],
    ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/],
    ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
    ["openai_key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/]
  ];
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export interface RepositoryHygieneResult {
  violations: string[];
}

export async function scanRepositoryHygiene(root: string): Promise<RepositoryHygieneResult> {
  const violations: string[] = [];
  const entries = await readdir(root, { recursive: true });
  const files = entries.filter((entry) => !entry.endsWith("/"));

  for (const relative of files) {
    const normalized = relative.replace(/\\/g, "/");
    const base = normalized.split("/").pop() ?? normalized;
    if (/^(run-report-v.+\.md|release-evidence-v.+\.json)$/.test(base)) {
      violations.push(`stale_generated_evidence:${normalized}`);
    }
    if (/\.(?:zip|tar|tgz|tar\.gz|tar\.xz)$/i.test(normalized)) {
      violations.push(`archive_committed:${normalized}`);
    }
    if (normalized === "test" || normalized.startsWith("test/") || normalized === "tests" || normalized.startsWith("tests/")) continue;
    let text: string;
    try { text = await readFile(join(root, relative), "utf8"); }
    catch { continue; }
    for (const hit of findSecretLikeTokens(text)) {
      const label = hit === "aws_access_key" ? "aws_access_key_shape" : `${hit}_shape`;
      violations.push(`${label}:${normalized}`);
    }
  }
  return { violations };
}
