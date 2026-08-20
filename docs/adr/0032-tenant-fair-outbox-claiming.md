# ADR 0032 — Tenant-fair outbox claiming

Status: Accepted in v0.0.92.

## Context

Tenant authorization and tenant-qualified SQL prevent data crossover, but a global FIFO outbox still allows one tenant to occupy every early worker slot. A synthetic regression placed 80 tenant-A events ahead of four tenant-B events. Under FIFO, tenant B would start at delivery position 81.

## Decision

Rank eligible events within each tenant using their existing queue order, then order claim candidates by tenant-local rank before taking the batch. This produces round-like interleaving across active tenants while keeping FIFO order inside each tenant.

SQLite uses `ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY rowid)`. PostgreSQL applies the same tenant rank over `(created_at,event_id)` and then uses `LIMIT` plus `FOR UPDATE OF o SKIP LOCKED` for concurrent queue consumers. In-memory storage mirrors the same rule.

## Result

With batch size 8, the process gate delivers `A,B,A,B,A,B,A,B`; tenant B reaches the sink in position 2. Aggregate sequence remains `1,2,3,4` for both tenants.

## Trade-off

Window ranking has a database cost on a large queue. The current project proves semantics, not production query-plan performance. A larger deployment could move to explicit per-tenant queue heads or a scheduler table if query plans show this ranking is too expensive.
