import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanRepositoryHygiene } from "../src/repository-hygiene.js";

test("repository hygiene flags stale generated evidence and committed archives", async () => {
  const root = await mkdtemp(join(tmpdir(), "rxflow-hygiene-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "run-report-v0.4.6.md"), "old");
  await writeFile(join(root, "bundle.zip"), "not really zip");
  const result = await scanRepositoryHygiene(root);
  assert.ok(result.violations.some((item) => item.startsWith("stale_generated_evidence:")));
  assert.ok(result.violations.some((item) => item.startsWith("archive_committed:")));
});

test("repository hygiene ignores secret sentinels in tests but not production text", async () => {
  const root = await mkdtemp(join(tmpdir(), "rxflow-hygiene-secret-"));
  await mkdir(join(root, "test"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  const fakeSecret = `AKIA${"A".repeat(16)}`;
  await writeFile(join(root, "test", "sentinel.ts"), `const x = ${JSON.stringify(fakeSecret)};`);
  assert.deepEqual((await scanRepositoryHygiene(root)).violations, []);
  await writeFile(join(root, "src", "bad.ts"), `const x = ${JSON.stringify(fakeSecret)};`);
  const result = await scanRepositoryHygiene(root);
  assert.ok(result.violations.some((item) => item.startsWith("aws_access_key_shape:")));
});
