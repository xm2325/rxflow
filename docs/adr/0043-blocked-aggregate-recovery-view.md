# ADR 0043 — Data-minimised blocked-aggregate recovery view

## Context

Per-case ordering can leave followers intentionally blocked behind a terminal head. Operations users need to know that the backlog is blocked and whether recovery is already being handled, but they do not need event payloads or recovery actor identities.

## Decision

Expose a read-only operations projection containing case ID, dead-letter head ID/type, recovery generation/ETag, blocked follower count and pending retirement-request ID. Keep request/approval and actor-level recovery history behind platform authentication.

## Consequences

Queue operators can distinguish blocked ordered work from ordinary backlog without receiving destructive authority or extra clinical/event data.
