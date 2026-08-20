# ADR 0014: Optimistic case versions for multi-instance workflow commits

## Decision

Every case carries an integer `version`. A state mutation that also writes integration events commits only when the durable version is still the version read by the worker. The new state is written with `version + 1` in the same store transaction as its outbox events.

## Why

Process-local checks do not protect two service instances. In particular, two workers can read the same retryable PA failure and both finish recovery. A status-only compare is also insufficient when a failed retry writes the same status again. Version comparison detects any intervening durable mutation.

## Evidence

A regression test creates a retryable PA failure, opens two SQLite connections, lets both workers generate the recovery draft, and releases both at the same time. One versioned commit wins. Only one `PaDraftGenerated` and one `HumanReviewRequired` event are stored.

## Limit

SQLite is only the local transaction adapter. The same version condition must be expressed as a row-level conditional update in the managed database used by a cloud deployment.
