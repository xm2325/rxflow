# ADR 0033 — Privacy-safe queue-pressure metrics

Status: Accepted in v0.0.93.

## Context

Fair claiming reduces starvation but a dominant tenant can still create most of the pending backlog. Operations need to see concentration without returning customer identifiers or event payloads from a generic worker metrics endpoint.

## Decision

Aggregate pressure in the store layer and expose only `pending`, `activePendingTenants`, `largestTenantPending`, and `largestTenantShare`. Tenant IDs are used only inside the aggregation query and are not returned.

## Result

A synthetic `12 + 4` pending-event split reports 16 pending events, two active pending tenants, and a largest backlog of 12. Unit and PostgreSQL SQL-contract tests also assert that the returned object has no tenant identifiers.
