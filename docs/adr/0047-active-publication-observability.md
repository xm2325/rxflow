# ADR 0047 — Active publication observability

## Decision

Keep worker `claimed`/`attempted`/`published` counters scoped to completed dispatcher ticks, and expose a separate `activePublication` boolean from `BackgroundOutboxPublisher`.

## Reason

A spawned late-arrival test observed real webhook delivery while completed-tick counters still read zero. Changing the counter semantics would make historical metrics harder to reason about; an explicit in-progress signal states the missing fact directly.

## Evidence

A unit test blocks the first sink delivery and verifies `isActive()` is true until the drain resolves. The late-arrival process gate also verifies `activePublication=true` while completed-tick counters have not yet advanced.
