import type { RuntimeConfig } from "./config.js";
import { PostgresCaseStore } from "./postgres-store.js";
import { InMemoryCaseStore, JsonFileCaseStore, SqliteCaseStore, type CaseStore } from "./store.js";

export async function createRuntimeStore(
  config: RuntimeConfig,
  postgresPoolFactory?: (config: NonNullable<RuntimeConfig["postgres"]>) => Promise<import("./postgres-store.js").PgPoolLike>
): Promise<CaseStore> {
  switch (config.storageMode) {
    case "sqlite":
      return new SqliteCaseStore(config.sqliteFile!);
    case "json":
      return new JsonFileCaseStore(config.jsonFile!);
    case "memory":
      return new InMemoryCaseStore();
    case "postgres": {
      const pgConfig = config.postgres;
      if (!pgConfig) throw new Error("missing_postgres_runtime_config");
      const makePool = postgresPoolFactory ?? (await import("./postgres-node.js")).createNodePostgresPool;
      const store = new PostgresCaseStore(await makePool(pgConfig));
      await store.initialize(config.postgresSchemaMode ?? "migrate");
      return store;
    }
  }
}

export async function closeRuntimeStore(store: CaseStore): Promise<void> {
  if (store instanceof SqliteCaseStore) {
    store.close();
    return;
  }
  if (store instanceof PostgresCaseStore) await store.close();
}
