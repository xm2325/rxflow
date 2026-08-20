export type StorageMode = "memory" | "json" | "sqlite" | "postgres";
export type EventSinkMode = "metadata" | "webhook" | "pubsub";
export type PostgresSchemaMode = "migrate" | "verify";
export type RuntimeRole = "api" | "worker";

export interface PostgresRuntimeConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  cloudSqlInstance?: string;
  poolMax: number;
  connectionTimeoutMs: number;
  queryTimeoutMs: number;
  statementTimeoutMs: number;
  idleInTransactionSessionTimeoutMs: number;
}

export interface StaticCredentialConfig {
  token: string;
  principal: string;
  tenantId: string;
  roles: Array<"ingest" | "operations" | "review" | "platform">;
}

export interface RuntimeConfig {
  nodeEnv: string;
  runtimeRole: RuntimeRole;
  port: number;
  publishIntervalMs: number;
  outboxBatchSize: number;
  outboxLeaseMs: number;
  outboxMaxAttempts: number;
  outboxRetryBaseMs: number;
  outboxRetryMaxMs: number;
  outboxPendingAgeTargetMs: number;
  outboxPerTenantClaimLimit: number;
  outboxTenantDeliveryConcurrency: number;
  readinessTimeoutMs: number;
  paTimeoutMs: number;
  paCircuitFailureThreshold: number;
  paCircuitResetMs: number;
  storageMode: StorageMode;
  sqliteFile?: string;
  jsonFile?: string;
  postgres?: PostgresRuntimeConfig;
  postgresSchemaMode?: PostgresSchemaMode;
  webhookUrl?: string;
  webhookSecret?: string;
  pubsubProject?: string;
  pubsubTopic?: string;
  cloudRunService?: string;
  eventSinkMode: EventSinkMode;
  ingestBearerToken?: string;
  operationsBearerToken?: string;
  operationsPrincipal?: string;
  reviewBearerToken?: string;
  reviewPrincipal?: string;
  requireApiAuth: boolean;
  trustPlatformIam: boolean;
  externalOutboxWorker: boolean;
  credentials?: StaticCredentialConfig[];
}

export function loadRuntimeConfig(env: Record<string, string | undefined>): RuntimeConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const runtimeRoleValue = clean(env.RXFLOW_RUNTIME_ROLE) ?? "api";
  if (runtimeRoleValue !== "api" && runtimeRoleValue !== "worker") throw new Error("invalid_runtime_role");
  const runtimeRole = runtimeRoleValue as RuntimeRole;
  const publishIntervalMs = parseInteger(env.RXFLOW_PUBLISH_INTERVAL_MS ?? "250", "invalid_publish_interval", 0, 86_400_000);
  const externalOutboxWorker = parseBoolean(env.RXFLOW_EXTERNAL_OUTBOX_WORKER ?? "false", "invalid_external_outbox_worker");
  const outboxBatchSize = parseInteger(env.RXFLOW_OUTBOX_BATCH_SIZE ?? "100", "invalid_outbox_batch_size", 1, 10_000);
  const outboxLeaseMs = parseInteger(env.RXFLOW_OUTBOX_LEASE_MS ?? "30000", "invalid_outbox_lease_ms", 100, 3_600_000);
  const outboxMaxAttempts = parseInteger(env.RXFLOW_OUTBOX_MAX_ATTEMPTS ?? "3", "invalid_outbox_max_attempts", 1, 100);
  const outboxRetryBaseMs = parseInteger(env.RXFLOW_OUTBOX_RETRY_BASE_MS ?? "1000", "invalid_outbox_retry_base_ms", 0, 3_600_000);
  const outboxRetryMaxMs = parseInteger(env.RXFLOW_OUTBOX_RETRY_MAX_MS ?? "60000", "invalid_outbox_retry_max_ms", 0, 86_400_000);
  const outboxPendingAgeTargetMs = parseInteger(env.RXFLOW_OUTBOX_PENDING_AGE_TARGET_MS ?? "60000", "invalid_outbox_pending_age_target_ms", 100, 86_400_000);
  const outboxPerTenantClaimLimit = parseInteger(env.RXFLOW_OUTBOX_PER_TENANT_CLAIM_LIMIT ?? String(outboxBatchSize), "invalid_outbox_per_tenant_claim_limit", 1, 10_000);
  const outboxTenantDeliveryConcurrency = parseInteger(env.RXFLOW_OUTBOX_TENANT_DELIVERY_CONCURRENCY ?? "1", "invalid_outbox_tenant_delivery_concurrency", 1, 100);
  if (outboxRetryBaseMs > outboxRetryMaxMs) throw new Error("invalid_outbox_retry_backoff");
  const sqliteFile = clean(env.RXFLOW_SQLITE_FILE);
  const jsonFile = clean(env.RXFLOW_DATA_FILE);
  const databaseUrl = clean(env.RXFLOW_DATABASE_URL);
  const pgHost = clean(env.RXFLOW_PGHOST);
  const cloudSqlInstance = clean(env.RXFLOW_CLOUD_SQL_INSTANCE);
  const pgDatabase = clean(env.RXFLOW_PGDATABASE);
  const pgUser = clean(env.RXFLOW_PGUSER);
  const pgPassword = clean(env.RXFLOW_PGPASSWORD);
  if (cloudSqlInstance && pgHost) throw new Error("conflicting_postgres_host_configuration");
  if (cloudSqlInstance && databaseUrl) throw new Error("conflicting_cloud_sql_configuration");
  if (cloudSqlInstance) validateCloudSqlInstance(cloudSqlInstance);
  const effectivePgHost = cloudSqlInstance ? `/cloudsql/${cloudSqlInstance}` : pgHost;
  const hasPgFields = Boolean(effectivePgHost || pgDatabase || pgUser || pgPassword || clean(env.RXFLOW_PGPORT));
  const configuredStores = [Boolean(sqliteFile), Boolean(jsonFile), Boolean(databaseUrl || hasPgFields)].filter(Boolean).length;
  if (configuredStores > 1) throw new Error("conflicting_storage_configuration");

  const pgPoolMax = parseInteger(env.RXFLOW_PG_POOL_MAX ?? "5", "invalid_pg_pool_max", 1, 100);
  const pgConnectionTimeoutMs = parseInteger(env.RXFLOW_PG_CONNECTION_TIMEOUT_MS ?? "5000", "invalid_pg_connection_timeout", 100, 300_000);
  const pgQueryTimeoutMs = parseInteger(env.RXFLOW_PG_QUERY_TIMEOUT_MS ?? "10000", "invalid_pg_query_timeout", 100, 600_000);
  const pgStatementTimeoutMs = parseInteger(env.RXFLOW_PG_STATEMENT_TIMEOUT_MS ?? "10000", "invalid_pg_statement_timeout", 100, 600_000);
  const pgIdleTransactionTimeoutMs = parseInteger(env.RXFLOW_PG_IDLE_TRANSACTION_TIMEOUT_MS ?? "15000", "invalid_pg_idle_transaction_timeout", 100, 600_000);
  const pgSafety = {
    poolMax: pgPoolMax,
    connectionTimeoutMs: pgConnectionTimeoutMs,
    queryTimeoutMs: pgQueryTimeoutMs,
    statementTimeoutMs: pgStatementTimeoutMs,
    idleInTransactionSessionTimeoutMs: pgIdleTransactionTimeoutMs
  };

  let postgres: PostgresRuntimeConfig | undefined;
  if (databaseUrl) {
    postgres = { connectionString: databaseUrl, ...pgSafety };
  } else if (hasPgFields) {
    if (!effectivePgHost || !pgDatabase || !pgUser || !pgPassword) throw new Error("incomplete_postgres_configuration");
    postgres = {
      host: effectivePgHost,
      port: parseInteger(env.RXFLOW_PGPORT ?? "5432", "invalid_pg_port", 1, 65535),
      database: pgDatabase,
      user: pgUser,
      password: pgPassword,
      ...(cloudSqlInstance ? { cloudSqlInstance } : {}),
      ...pgSafety
    };
  }

  const configuredSchemaMode = clean(env.RXFLOW_PG_SCHEMA_MODE);
  if (configuredSchemaMode && configuredSchemaMode !== "migrate" && configuredSchemaMode !== "verify") {
    throw new Error("invalid_pg_schema_mode");
  }
  const postgresSchemaMode: PostgresSchemaMode | undefined = postgres
    ? (configuredSchemaMode as PostgresSchemaMode | undefined) ?? (nodeEnv === "production" ? "verify" : "migrate")
    : undefined;

  const webhookUrl = clean(env.RXFLOW_WEBHOOK_URL);
  const webhookSecret = clean(env.RXFLOW_WEBHOOK_SECRET);
  if ((webhookUrl && !webhookSecret) || (!webhookUrl && webhookSecret)) {
    throw new Error("incomplete_webhook_configuration");
  }
  if (webhookSecret && webhookSecret.length < 16) throw new Error("webhook_secret_too_short");

  const pubsubProject = clean(env.RXFLOW_PUBSUB_PROJECT);
  const pubsubTopic = clean(env.RXFLOW_PUBSUB_TOPIC);
  if ((pubsubProject && !pubsubTopic) || (!pubsubProject && pubsubTopic)) throw new Error("incomplete_pubsub_configuration");
  if (webhookUrl && pubsubProject) throw new Error("conflicting_event_sink_configuration");

  const storageMode: StorageMode = postgres ? "postgres" : sqliteFile ? "sqlite" : jsonFile ? "json" : "memory";
  if (nodeEnv === "production" && storageMode === "memory") {
    throw new Error("production_requires_persistent_store");
  }



  const credentialJson = clean(env.RXFLOW_CREDENTIALS_JSON);
  const credentials = credentialJson ? parseCredentialConfig(credentialJson) : undefined;
  const ingestBearerToken = clean(env.RXFLOW_INGEST_BEARER_TOKEN);
  const operationsBearerToken = clean(env.RXFLOW_OPERATIONS_BEARER_TOKEN);
  const operationsPrincipal = clean(env.RXFLOW_OPERATIONS_PRINCIPAL);
  const reviewBearerToken = clean(env.RXFLOW_REVIEW_BEARER_TOKEN);
  const reviewPrincipal = clean(env.RXFLOW_REVIEW_PRINCIPAL);
  if (credentials && [ingestBearerToken, operationsBearerToken, operationsPrincipal, reviewBearerToken, reviewPrincipal].some(Boolean)) {
    throw new Error("conflicting_api_auth_configuration");
  }
  const reviewAuthParts = [reviewBearerToken, reviewPrincipal].filter(Boolean).length;
  if (reviewAuthParts !== 0 && reviewAuthParts !== 2) throw new Error("incomplete_review_auth_configuration");
  if (reviewBearerToken && reviewBearerToken.length < 24) throw new Error("review_bearer_token_too_short");

  const requireApiAuth = parseBoolean(env.RXFLOW_REQUIRE_API_AUTH ?? "false", "invalid_require_api_auth");
  const trustPlatformIam = parseBoolean(env.RXFLOW_TRUST_PLATFORM_IAM ?? "false", "invalid_trust_platform_iam");
  const authParts = [ingestBearerToken, operationsBearerToken, operationsPrincipal].filter(Boolean).length;
  if (authParts !== 0 && authParts !== 3) throw new Error("incomplete_api_auth_configuration");
  if (ingestBearerToken && ingestBearerToken.length < 24) throw new Error("ingest_bearer_token_too_short");
  if (operationsBearerToken && operationsBearerToken.length < 24) throw new Error("operations_bearer_token_too_short");
  if (requireApiAuth && !credentials && authParts !== 3) throw new Error("required_api_auth_not_configured");
  if (nodeEnv === "production" && requireApiAuth && !credentials && reviewAuthParts !== 2) {
    throw new Error("production_api_auth_requires_dedicated_reviewer");
  }
  if (nodeEnv === "production" && requireApiAuth && credentials) {
    const tenantsWithOperations = new Set(credentials.filter((c) => c.roles.includes("operations")).map((c) => c.tenantId));
    const tenantsWithReview = new Set(credentials.filter((c) => c.roles.includes("review")).map((c) => c.tenantId));
    for (const tenantId of tenantsWithOperations) {
      if (!tenantsWithReview.has(tenantId)) throw new Error("production_api_auth_requires_tenant_reviewer");
    }
  }

  const eventSinkMode: EventSinkMode = pubsubProject ? "pubsub" : webhookUrl ? "webhook" : "metadata";
  const cloudRunService = clean(env.K_SERVICE);
  if (nodeEnv === "production" && cloudRunService && storageMode !== "postgres") {
    throw new Error("cloud_run_requires_shared_postgres_store");
  }
  if (nodeEnv === "production" && cloudRunService && eventSinkMode === "metadata" && !(runtimeRole === "api" && externalOutboxWorker)) {
    throw new Error("cloud_run_requires_external_event_sink");
  }
  if (nodeEnv === "production" && cloudRunService && runtimeRole === "api" && !requireApiAuth && !trustPlatformIam) {
    throw new Error("cloud_run_requires_auth_boundary");
  }
  if (runtimeRole === "api" && externalOutboxWorker && publishIntervalMs !== 0) {
    throw new Error("external_outbox_worker_requires_disabled_api_publisher");
  }
  if (nodeEnv === "production" && cloudRunService && runtimeRole === "api" && publishIntervalMs === 0 && !externalOutboxWorker) {
    throw new Error("cloud_run_requires_outbox_publisher");
  }
  if (runtimeRole === "worker" && publishIntervalMs === 0) {
    throw new Error("worker_requires_publish_interval");
  }


  const port = parseInteger(env.PORT ?? "8080", "invalid_port", 1, 65535);
  const readinessTimeoutMs = parseInteger(env.RXFLOW_READINESS_TIMEOUT_MS ?? "2000", "invalid_readiness_timeout", 10, 60_000);
  const paTimeoutMs = parseInteger(env.RXFLOW_PA_TIMEOUT_MS ?? "5000", "invalid_pa_timeout", 1, 300_000);
  const paCircuitFailureThreshold = parseInteger(env.RXFLOW_PA_CIRCUIT_FAILURE_THRESHOLD ?? "3", "invalid_pa_circuit_failure_threshold", 1, 100);
  const paCircuitResetMs = parseInteger(env.RXFLOW_PA_CIRCUIT_RESET_MS ?? "30000", "invalid_pa_circuit_reset", 1, 3_600_000);

  return {
    nodeEnv,
    runtimeRole,
    port,
    publishIntervalMs,
    outboxBatchSize,
    outboxLeaseMs,
    outboxMaxAttempts,
    outboxRetryBaseMs,
    outboxRetryMaxMs,
    outboxPendingAgeTargetMs,
    outboxPerTenantClaimLimit,
    outboxTenantDeliveryConcurrency,
    readinessTimeoutMs,
    paTimeoutMs,
    paCircuitFailureThreshold,
    paCircuitResetMs,
    requireApiAuth,
    trustPlatformIam,
    externalOutboxWorker,
    eventSinkMode,
    storageMode,
    ...(sqliteFile ? { sqliteFile } : {}),
    ...(jsonFile ? { jsonFile } : {}),
    ...(postgres ? { postgres, postgresSchemaMode } : {}),
    ...(webhookUrl ? { webhookUrl, webhookSecret } : {}),
    ...(pubsubProject ? { pubsubProject, pubsubTopic } : {}),
    ...(cloudRunService ? { cloudRunService } : {}),
    ...(ingestBearerToken ? { ingestBearerToken, operationsBearerToken, operationsPrincipal } : {}),
    ...(reviewBearerToken ? { reviewBearerToken, reviewPrincipal } : {}),
    ...(credentials ? { credentials } : {})
  };
}

function parseCredentialConfig(raw: string): StaticCredentialConfig[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("invalid_credentials_json"); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("invalid_credentials_json");
  const allowedRoles = new Set(["ingest", "operations", "review", "platform"]);
  const tokens = new Set<string>();
  return parsed.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("invalid_credentials_json");
    const value = entry as Record<string, unknown>;
    const token = typeof value.token === "string" ? value.token.trim() : "";
    const principal = typeof value.principal === "string" ? value.principal.trim() : "";
    const tenantId = typeof value.tenantId === "string" ? value.tenantId.trim() : "";
    const roles = Array.isArray(value.roles) ? value.roles : [];
    if (token.length < 24 || !principal || !tenantId || !roles.length || !roles.every((role) => typeof role === "string" && allowedRoles.has(role))) {
      throw new Error("invalid_credentials_json");
    }
    if (tokens.has(token)) throw new Error("duplicate_credential_token");
    tokens.add(token);
    return { token, principal, tenantId, roles: roles as StaticCredentialConfig["roles"] };
  });
}

function clean(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function parseInteger(value: string, code: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(code);
  return parsed;
}


function parseBoolean(value: string, code: string): boolean {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(code);
}

function validateCloudSqlInstance(value: string): void {
  // Cloud SQL connection names use project:region:instance and the Unix socket path
  // must fit Linux sun_path when the PostgreSQL socket suffix is appended.
  if (!/^[A-Za-z0-9._-]+:[A-Za-z0-9-]+:[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("invalid_cloud_sql_instance");
  }
  const fullSocketPath = `/cloudsql/${value}/.s.PGSQL.5432`;
  if (fullSocketPath.length >= 108) throw new Error("cloud_sql_socket_path_too_long");
}
