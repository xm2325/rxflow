import type { PostgresRuntimeConfig } from "./config.js";
import type { PgPoolLike } from "./postgres-store.js";

/** Load node-postgres only when the PostgreSQL store is selected at runtime. */
export async function createNodePostgresPool(config: PostgresRuntimeConfig): Promise<PgPoolLike> {
  const { Pool } = await import("pg");
  const safety = {
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    query_timeout: config.queryTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    idle_in_transaction_session_timeout: config.idleInTransactionSessionTimeoutMs,
    application_name: "rxflow"
  };
  const poolConfig: Record<string, unknown> = config.connectionString
    ? { connectionString: config.connectionString, ...safety }
    : {
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
        ...safety
      };
  return new Pool(poolConfig) as unknown as PgPoolLike;
}
