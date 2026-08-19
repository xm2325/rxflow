# ADR 0018 — tenant isolation at the application boundary

## Status
Accepted for the synthetic portfolio service.

## Context
A shared healthcare workflow service must not allow an authenticated user from one health-system tenant to read, review, or operate on another tenant's cases. A caller-supplied tenant header is not a trusted identity boundary.

## Decision
Bearer credentials bind a server-configured principal, role, and tenant. Workflow idempotency keys are namespaced by tenant; cases carry tenant provenance; service reads, lists, reviews, work queues, and dead-letter operations are filtered by that authenticated tenant. Cross-tenant lookups use not-found semantics. Integration-event envelopes carry tenant context for downstream routing, while tenant identifiers are not duplicated inside business payloads. Aggregate metrics require a platform role when the credential registry is active.

## Limits
This is application-layer isolation, not PostgreSQL row-level security and not an identity-provider integration. The raw store interface remains capable of platform-wide access and must only be used by trusted service code. Production identity federation and database policy enforcement remain deployment work.
