# ADR 0001: Durable outbox with at-least-once delivery

## Decision

Workflow state and integration events are written through one storage boundary. A dispatcher publishes pending events and records delivery attempts. Consumers use `eventId` for idempotency.

## Why

Writing application state and publishing directly to a broker creates a dual-write failure window. The outbox makes that failure explicit and recoverable. Exactly-once delivery is not assumed.

## Cloud mapping

A production GCP implementation can persist the outbox in a managed database and publish to Pub/Sub. Dead-letter policy belongs at both the application and transport boundaries, with alerting when messages stop making progress.
