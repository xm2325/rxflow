import { access, readFile, readdir } from "node:fs/promises";
import { VERSION } from "./version.js";
import { findSecretLikeTokens } from "./repository-hygiene.js";
import { extractLocalRepositoryReferences } from "./public-surface.js";

const root = new URL("../../", import.meta.url);
const paths = await readdir(root, { recursive: true });
const ignoredPrefixes = ["dist/", "artifacts/", "node_modules/", ".git/", ".data/"];
const intentionalSecretFixtures = new Set([
  "src/repository-hygiene.ts",
  "test/repository-hygiene.test.ts"
]);
const textExtensions = /\.(?:md|html|json|ts|js|mjs|css|yml|yaml|tf)$/;
const topLevelText = new Set(["README.md", "SECURITY.md", "Dockerfile", "package.json", "package-lock.json", ".gitignore", ".dockerignore"]);

function ignored(path: string): boolean {
  return ignoredPrefixes.some((prefix) => path.startsWith(prefix));
}

for (const publicHtml of ["docs/index.html", "docs/portfolio.html"]) {
  const text = await readFile(new URL(publicHtml, root), "utf8");
  if (!text.includes(`RxFlow v${VERSION}`)) throw new Error(`public_surface_stale_release:${publicHtml}`);
}

const generatedCurrentReferences = new Set([
  `docs/run-report-v${VERSION}.md`,
  `docs/release-evidence-v${VERSION}.json`
]);
const brokenLinks: string[] = [];
let localLinksChecked = 0;
for (const path of paths) {
  if (ignored(path) || !(path === "README.md" || path === "SECURITY.md" || (path.startsWith("docs/") && /\.(?:md|html)$/.test(path)))) continue;
  let text: string;
  try {
    text = await readFile(new URL(path, root), "utf8");
  } catch {
    continue;
  }
  const format = path.endsWith(".html") ? "html" : "markdown";
  for (const ref of extractLocalRepositoryReferences(text, format)) {
    localLinksChecked += 1;
    const source = new URL(path, root);
    const target = new URL(ref, source);
    try {
      await access(target);
    } catch {
      const rootRelative = target.pathname.startsWith(root.pathname) ? target.pathname.slice(root.pathname.length) : "";
      if (!generatedCurrentReferences.has(rootRelative)) brokenLinks.push(`${path}->${ref}`);
    }
  }
}
if (brokenLinks.length) throw new Error(`public_surface_broken_local_reference:${brokenLinks.join("|")}`);

const secretHits: string[] = [];
let secretFilesScanned = 0;
for (const path of paths) {
  if (ignored(path) || intentionalSecretFixtures.has(path)) continue;
  if (!topLevelText.has(path) && !textExtensions.test(path)) continue;
  let text: string;
  try {
    text = await readFile(new URL(path, root), "utf8");
  } catch {
    continue;
  }
  secretFilesScanned += 1;
  for (const hit of findSecretLikeTokens(text)) secretHits.push(`${path}:${hit}`);
}
if (secretHits.length) throw new Error(`public_surface_secret_like_token:${secretHits.join("|")}`);

console.log(JSON.stringify({
  publicSurface: "ok",
  version: VERSION,
  localLinksChecked,
  brokenLocalLinks: 0,
  secretFilesScanned,
  secretLikeTokens: 0,
  scope: "repository text and public local references; not a full secret-scanning service"
}, null, 2));
