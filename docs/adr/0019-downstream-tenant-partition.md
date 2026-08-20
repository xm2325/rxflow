# ADR 0019 — partition downstream side effects by tenant

## Status
Accepted.

## Context
Application-level tenant isolation is incomplete if a shared downstream consumer deduplicates solely by event ID or stores projection state solely by case ID. A collision or reused identifier could let one tenant suppress or overwrite another tenant's downstream state.

## Decision
The synthetic SQLite pharmacy consumer stores processed-event markers under `(tenant_id, event_id)` and route projection state under `(tenant_id, case_id)`. Legacy rows migrate into the `default` tenant. Tenant context comes from the validated integration-event envelope.

## Limits
This demonstrates downstream partition semantics in the local consumer. It is not a managed multi-tenant database policy, PostgreSQL row-level security, or a production pharmacy integration.
