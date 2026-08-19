# ADR 0016: Per-case event sequence for reordered delivery

## Decision

Workflow-generated integration events carry `aggregateSequence`, a monotonically increasing number stored with the case. The downstream route projection stores the latest sequence and ignores a different event ID when its sequence is older than or equal to the applied route event.

## Why

`eventId` deduplication protects against replay of the same event, but it does not protect against a different older event arriving after a newer event. Queue delivery order should not be treated as a business invariant.

## Evidence

A regression test applies route sequence 8 and then route sequence 4 for the same case. The second message is recorded as processed but does not overwrite the route side effect. A migration test confirms that a projection table created before sequence tracking can still be opened.

## Limit

The current projection demonstrates ordering safety for pharmacy routing. A larger downstream read model would define type-specific stale-event rules rather than apply one rule blindly to every event type.
