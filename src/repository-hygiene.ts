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
