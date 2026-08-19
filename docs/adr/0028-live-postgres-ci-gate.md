# ADR 0028 — Run PostgreSQL invariants against a real service in CI

## Status
Accepted in v0.0.85.

## Context
The repository has a PostgreSQL adapter and injected SQL/transaction tests, but the current sandbox has no PostgreSQL server and cannot install the `pg` package because outbound package installation times out. Contract tests cannot prove PostgreSQL locking and timestamp behavior by themselves.

## Decision
CI now has a separate PostgreSQL 17 service-container job. It installs runtime dependencies and runs `npm run test:postgres:live`. The live script covers transactional case/outbox writes, tenant-scoped idempotency, a forced cross-instance idempotency race, two-worker `FOR UPDATE SKIP LOCKED` draining, lease renewal/reclaim with stale-ack rejection, and retry scheduling from the failure-completion timestamp.

## Evidence boundary
The local infrastructure gate checks that the PostgreSQL CI job is wired into `.github/workflows/ci.yml`, but this sandbox has not executed that service-container job. A live-PostgreSQL claim should be made only after the CI job is observed passing in GitHub.
