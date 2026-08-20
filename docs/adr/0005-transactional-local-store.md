# ADR 0005: Prove atomic case/outbox semantics with a transactional local store

The JSON snapshot adapter is useful for restart demos but it cannot represent a multi-instance production database and it has a write-race risk if multiple processes update the same file. v0.0.11 adds a SQLite-backed `CaseStore` using one transaction for case/idempotency/outbox mutations.

A test forces an outbox primary-key failure during `saveWithOutbox` and verifies that the case mutation is rolled back. This is the local proof of the atomicity property the cloud database adapter must preserve.

Node 22 exposes `node:sqlite` as an experimental API in the current runtime. It is used here to avoid a third-party dependency in the runnable portfolio environment, not as the recommended production healthcare database. Cloud deployment should use a managed transactional database.
