import assert from "node:assert/strict";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config.js";

test("production refuses an in-memory store", () => {
  assert.throws(() => loadRuntimeConfig({ NODE_ENV: "production" }), /production_requires_persistent_store/);
});

test("worker runtime requires a positive publish interval", () => {
  assert.throws(
    () => loadRuntimeConfig({ RXFLOW_RUNTIME_ROLE: "worker", RXFLOW_PUBLISH_INTERVAL_MS: "0" }),
    /worker_requires_publish_interval/
  );
});

test("API with external worker requires in-process publisher disabled", () => {
  assert.throws(
    () => loadRuntimeConfig({ RXFLOW_EXTERNAL_OUTBOX_WORKER: "true", RXFLOW_PUBLISH_INTERVAL_MS: "250" }),
    /external_outbox_worker_requires_disabled_api_publisher/
  );
});

test("complete PostgreSQL configuration selects the postgres store", () => {
  const config = loadRuntimeConfig({
    RXFLOW_PGHOST: "127.0.0.1",
    RXFLOW_PGDATABASE: "rxflow",
    RXFLOW_PGUSER: "rxflow",
    RXFLOW_PGPASSWORD: "synthetic-password"
  });
  assert.equal(config.storageMode, "postgres");
  assert.equal(config.postgres?.port, 5432);
});
