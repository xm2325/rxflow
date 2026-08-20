import { readFile, readdir } from "node:fs/promises";
import { VERSION } from "./version.js";

interface PackageManifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
}
interface LockPackage {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dev?: boolean;
}
interface PackageLock {
  name?: string;
  version?: string;
  lockfileVersion?: number;
  packages?: Record<string, LockPackage>;
}

const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as PackageManifest;
const lock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8")) as PackageLock;
const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");
const workflowDir = new URL("../../.github/workflows/", import.meta.url);
const workflowFiles = (await readdir(workflowDir)).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
const workflowTexts = await Promise.all(workflowFiles.map(async (name) => await readFile(new URL(name, workflowDir), "utf8")));
const ci = workflowTexts.join("\n--- workflow boundary ---\n");

if (packageJson.name !== "rxflow" || lock.name !== packageJson.name) throw new Error("dependency_lock_name_mismatch");
if (packageJson.version !== VERSION || lock.version !== VERSION) throw new Error("dependency_lock_version_mismatch");
if (lock.lockfileVersion !== 3) throw new Error("dependency_lock_version_must_be_3");
if (packageJson.packageManager !== "npm@10.9.2") throw new Error("dependency_lock_package_manager_not_pinned");
if (packageJson.dependencies?.pg !== "8.16.3") throw new Error("dependency_lock_pg_manifest_not_exact");
if (packageJson.devDependencies?.typescript !== "5.8.3") throw new Error("dependency_lock_typescript_manifest_not_exact");

const root = lock.packages?.[""];
if (!root || root.name !== "rxflow" || root.version !== VERSION || root.dependencies?.pg !== "8.16.3" || root.devDependencies?.typescript !== "5.8.3") {
  throw new Error("dependency_lock_root_mismatch");
}
const pg = lock.packages?.["node_modules/pg"];
if (!pg || pg.version !== "8.16.3") throw new Error("dependency_lock_pg_entry_missing");
const typescript = lock.packages?.["node_modules/typescript"];
if (!typescript || typescript.version !== "5.8.3" || typescript.dev !== true) throw new Error("dependency_lock_typescript_entry_missing");

let lockedPackages = 0;
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (path === "") continue;
  lockedPackages += 1;
  if (!entry.version) throw new Error(`dependency_lock_package_version_missing:${path}`);
  if (!entry.resolved?.startsWith("https://registry.npmjs.org/")) throw new Error(`dependency_lock_resolved_missing:${path}`);
  if (!entry.integrity?.startsWith("sha512-")) throw new Error(`dependency_lock_integrity_missing:${path}`);
}
if (lockedPackages < 10) throw new Error("dependency_lock_tree_too_small");

if (!dockerfile.includes("COPY package.json package-lock.json")) throw new Error("dependency_lock_docker_copy_missing");
if (!dockerfile.includes("npm ci --omit=dev")) throw new Error("dependency_lock_docker_npm_ci_missing");
if (dockerfile.includes("npm install --omit=dev")) throw new Error("dependency_lock_docker_legacy_install_present");
if (/npm install -g typescript/.test(dockerfile)) throw new Error("dependency_lock_docker_global_typescript_present");

const npmCiCount = ci.split("npm ci --ignore-scripts --no-audit --no-fund").length - 1;
if (npmCiCount < 2) throw new Error("dependency_lock_ci_npm_ci_missing");
if (/^\s*-\s+run:\s+npm install(?:\s|$)/m.test(ci)) throw new Error("dependency_lock_ci_legacy_install_present");
if (/npm install -g typescript/.test(ci)) throw new Error("dependency_lock_ci_global_typescript_present");

console.log(JSON.stringify({
  dependencyLock: "ok",
  version: VERSION,
  packageManager: packageJson.packageManager,
  directRuntimeDependency: "pg@8.16.3",
  lockedBuildTool: "typescript@5.8.3",
  lockfileVersion: lock.lockfileVersion,
  lockedPackages,
  ciUsesNpmCi: true,
  workflowFilesChecked: workflowFiles.length,
  dockerUsesNpmCi: true
}, null, 2));
