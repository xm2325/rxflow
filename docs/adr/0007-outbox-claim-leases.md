# ADR 0007: Lease-based outbox claims

## Decision

Outbox workers must atomically claim records before network delivery. Each claim has `claimedBy`, a unique `claimId`, and `leaseUntil`. Only the current claim ID can mark a record published or failed. Expired claims can return to the pending queue and be reclaimed.

## Reason

A process-local lock prevents overlapping work only inside one Node process. It does not protect two service instances that share a queue. A durable claim stored with the queue record moves coordination to the shared store.

## Consequence

This reduces simultaneous processing but does not change the at-least-once delivery contract. Receiver-side deduplication is still required.
