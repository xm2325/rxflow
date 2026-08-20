import assert from "node:assert/strict";
import test from "node:test";
import { extractLocalRepositoryReferences, isLocalRepositoryReference } from "../src/public-surface.js";

test("public-surface parser keeps repository links and ignores external schemes", () => {
  const refs = extractLocalRepositoryReferences(
    "[local](docs/architecture.md) [section](#top) [web](https://example.com) ![img](docs/assets/architecture.svg)",
    "markdown"
  );
  assert.equal(refs.length, 2);
  assert.equal(refs[0], "docs/architecture.md");
  assert.equal(refs[1], "docs/assets/architecture.svg");
});

test("public-surface parser handles HTML assets and query or fragment suffixes", () => {
  const refs = extractLocalRepositoryReferences(
    '<link href="./assets/site.css?v=1"><img src="assets/architecture.svg#diagram"><a href="mailto:test@example.com">x</a>',
    "html"
  );
  assert.equal(refs.length, 2);
  assert.equal(refs[0], "./assets/site.css");
  assert.equal(refs[1], "assets/architecture.svg");
  assert.equal(isLocalRepositoryReference("data:image/png;base64,abc"), false);
});
