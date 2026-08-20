import { loadRuntimeConfig } from "./config.js";
import { createNodePostgresPool } from "./postgres-node.js";
import { PostgresCaseStore, POSTGRES_SCHEMA_VERSION } from "./postgres-store.js";

const config = loadRuntimeConfig(process.env);
if (config.storageMode !== "postgres" || !config.postgres) {
  throw new Error("postgres_configuration_required_for_migration");
}

const store = new PostgresCaseStore(await createNodePostgresPool(config.postgres));
try {
  await store.migrate();
  console.log(JSON.stringify({ event: "postgres_migration_complete", schemaVersion: POSTGRES_SCHEMA_VERSION }));
} finally {
  await store.close();
}
