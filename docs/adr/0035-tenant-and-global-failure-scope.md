# ADR 0035 — Tenant and global delivery-failure scope

## Decision

Retryable outbound failures carry one of three scopes: `record`, `tenant`, or `global`.

A tenant-scoped failure defers untouched claims belonging to the failed tenant while allowing other tenants in the batch to continue. A global failure defers all untouched claims and stops the batch. Record-scoped failures affect only the failed record.

## Why

HTTP status alone does not identify the affected population. A webhook 429 can represent a tenant-specific downstream quota, while a Pub/Sub 429 can represent shared publisher/project capacity. Treating every 429 as global creates avoidable cross-tenant impact; treating every 429 as tenant-local can overload shared infrastructure.

## Evidence

A spawned worker processes four events each for health A and health B. Health A receives `429 Retry-After: 1`; the remaining A claims are deferred without attempt cost while all four health-B events publish. The same dispatcher still short-circuits the full untouched batch after a global 503.
