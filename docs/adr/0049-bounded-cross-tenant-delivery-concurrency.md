# ADR 0049 — Bounded cross-tenant delivery concurrency

## Status

Accepted in v0.2.4 and carried into v0.2.6.

## Context

Tenant-fair queue claiming controls durable ownership, but it does not control execution latency after a claim. With a single delivery slot, a tenant whose webhook takes 200ms can still delay a different tenant whose webhook takes 10ms.

## Decision

Add `RXFLOW_OUTBOX_TENANT_DELIVERY_CONCURRENCY`. A dispatcher may run several tenant lanes at once, but only one external request from a given tenant may be active in that dispatcher. After each completed record, the tenant lane returns to the back of the ready queue.

## Consequences

- Fast tenants can progress while another tenant has a slow call in flight.
- Tenant-scoped throttle semantics stay predictable because another same-tenant call has not already started.
- The concurrency limit is also a downstream fan-out limit; it is not a throughput claim.
- Per-tenant claim quantum and tenant delivery concurrency remain separate controls: one limits durable ownership, the other limits active side effects.

## Evidence

A spawned worker comparison uses 200ms tenant-A responses and 10ms tenant-B responses. The concurrency-1 phase makes B wait behind an A call; the concurrency-2 phase lets B complete while A is still waiting and records `peakConcurrentDeliveries=2`. Unit tests prove same-tenant peak concurrency remains one.
