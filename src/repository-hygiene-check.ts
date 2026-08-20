import { readFile, readdir } from "node:fs/promises";
import { VERSION } from "./version.js";
import { findSecretLikeTokens, staleGeneratedEvidence } from "./repository-hygiene.js";

const root = new URL("../../", import.meta.url);
const docs = await readdir(new URL("docs/", root));
const stale = staleGeneratedEvidence(docs, VERSION);
if (stale.length) throw new Error(`repository_hygiene_stale_generated_evidence:${stale.join("|")}`);

const gitignore = await readFile(new URL(".gitignore", root), "utf8");
for (const required of ["dist/", "node_modules/", ".env", "artifacts/"]) {
  if (!gitignore.includes(required)) throw new Error(`repository_hygiene_gitignore_missing:${required}`);
}
const dockerignore = await readFile(new URL(".dockerignore", root), "utf8");
for (const required of [".git", "node_modules", "dist", "artifacts", ".env", "*.zip"]) {
  if (!dockerignore.includes(required)) throw new Error(`repository_hygiene_dockerignore_missing:${required}`);
}

const readme = await readFile(new URL("README.md", root), "utf8");
if (!readme.includes(`## Current release: v${VERSION}`)) throw new Error("repository_hygiene_readme_version_mismatch");
if (!readme.includes("npm ci")) throw new Error("repository_hygiene_readme_npm_ci_missing");
if (!readme.includes("npm run demo:evidence")) throw new Error("repository_hygiene_readme_evidence_demo_missing");

const security = await readFile(new URL("SECURITY.md", root), "utf8");
if (!security.includes("synthetic") || !security.includes("not a compliance certification")) {
  throw new Error("repository_hygiene_security_boundary_missing");
}

const scanTargets = ["package.json", "Dockerfile", "README.md", "SECURITY.md"];
const secretHits: string[] = [];
for (const target of scanTargets) {
  const text = await readFile(new URL(target, root), "utf8");
  for (const hit of findSecretLikeTokens(text)) secretHits.push(`${target}:${hit}`);
}
if (secretHits.length) throw new Error(`repository_hygiene_secret_like_token:${secretHits.join("|")}`);

console.log(JSON.stringify({
  repositoryHygiene: "ok",
  version: VERSION,
  staleGeneratedEvidence: 0,
  gitignore: "bounded",
  dockerignore: "bounded",
  securityPolicy: "synthetic-data boundary present",
  scannedSecretLikeTokens: 0
}, null, 2));
