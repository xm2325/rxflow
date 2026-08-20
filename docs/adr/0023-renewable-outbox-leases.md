# ADR 0023 — Renewable outbox leases for slow delivery

## Status

Accepted in v0.0.78; process-level regression gate added in v0.0.79.

## Context

The outbox worker originally claimed a batch with one fixed lease and then delivered records sequentially. Claim tokens and stale-ack rejection protected ownership only while the lease remained valid.

A targeted regression used a 50 ms lease and an 80 ms sink. Worker A claimed four records and began sequential delivery. Before it completed, Worker B reclaimed the expired records. Four unique event IDs produced eight transport deliveries.

The failure was not caused by missing claim tokens. The ownership timeout was shorter than healthy work and was not refreshed while progress continued.

## Decision

Add `renewOutboxLease(eventId, claimId, leaseMs, now?)` to the durable store contract and implement it in every store adapter.

While a claimed batch is active, the dispatcher maintains a heartbeat at approximately one third of the lease duration, with a small lower bound. The heartbeat renews every outstanding record in the batch, including records waiting behind the current delivery.

A renewal succeeds only when the event ID, claim ID, and current ownership still match. The existing claim token therefore remains the authority for acknowledgement and renewal.

## Consequences

A healthy slow worker can retain ownership beyond the original lease without requiring an excessively long static timeout. If the worker dies, renewal stops and another worker can reclaim the record after the bounded lease period.

Renewal does not produce exactly-once transport. A sender can still deliver successfully and fail before storing its acknowledgement. Stable event IDs and transactional consumer deduplication remain required.

Worker metrics expose lease-renewal successes and failures so the ownership mechanism is visible during operation.

## Evidence

The spawned regression uses two worker OS processes, a 150 ms lease, and a signed-webhook receiver that delays each response by 260 ms. The final v0.0.82 release recorded four unique event IDs, four deliveries, zero duplicate transport deliveries, 52 lease renewals, zero renewal failures, and four published records.
