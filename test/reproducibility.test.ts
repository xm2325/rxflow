import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

test("package lock pins direct runtime dependency with integrity metadata", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(manifest.packageManager, "npm@10.9.2");
  assert.equal(manifest.dependencies.pg, "8.16.3");
  assert.equal(manifest.devDependencies.typescript, "5.8.3");
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.packages[""].dependencies.pg, "8.16.3");
  assert.equal(lock.packages[""].devDependencies.typescript, "5.8.3");
  assert.equal(lock.packages["node_modules/pg"].version, "8.16.3");
  assert.match(lock.packages["node_modules/pg"].integrity, /^sha512-/);
  assert.equal(lock.packages["node_modules/typescript"].version, "5.8.3");
  assert.equal(lock.packages["node_modules/typescript"].dev, true);
  assert.match(lock.packages["node_modules/typescript"].integrity, /^sha512-/);
});

test("GitHub workflows use npm ci and no longer install TypeScript globally", async () => {
  const workflowDir = new URL("../.github/workflows/", import.meta.url);
  const files = (await readdir(workflowDir)).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
  const workflows = (await Promise.all(files.map(async (name) => await readFile(new URL(name, workflowDir), "utf8")))).join("\n--- workflow boundary ---\n");
  const npmCiCount = workflows.split("npm ci --ignore-scripts --no-audit --no-fund").length - 1;
  assert.ok(npmCiCount >= 2);
  assert.doesNotMatch(workflows, /^\s*-\s+run:\s+npm install(?:\s|$)/m);
  assert.doesNotMatch(workflows, /npm install -g typescript/);
});

test("Docker build and runtime stages install from package lock", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /COPY package\.json package-lock\.json/);
  assert.match(dockerfile, /RUN npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts --no-audit --no-fund/);
  assert.doesNotMatch(dockerfile, /npm install --omit=dev/);
  assert.doesNotMatch(dockerfile, /npm install -g typescript/);
});
