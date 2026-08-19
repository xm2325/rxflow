# ADR 0046 — Use one PostgreSQL lock order for recovery decisions

## Status

Accepted in v0.2.0.

## Context

PostgreSQL redrive locked the outbox row and then changed the retirement-request row. Approval previously locked the retirement-request row before locking the outbox row. Concurrent approve/redrive operations could therefore form a lock cycle:

```text
approval: request -> waits for outbox
redrive:  outbox  -> waits for request
```

That is a possible database deadlock even when both operations are individually transactional.

## Decision

Approval now performs an unlocked identity read first, then acquires durable locks in the same order as redrive:

```text
read request identity (no row lock)
        -> lock outbox row FOR UPDATE
        -> lock request row FOR UPDATE
        -> revalidate request status, generation, and separation of duties
        -> commit one recovery decision
```

The initial read is not trusted as the final decision state. All relevant conditions are re-read and validated after both locks are held.

## Evidence

A local SQL-order unit test checks that the outbox `FOR UPDATE` query occurs before the retirement-request `FOR UPDATE` query. The PostgreSQL 17 live-CI script also races approval against redrive with a five-second timeout, expects one operation to win, and rejects `40P01` / `deadlock detected` results.

The current sandbox has no live PostgreSQL service, so the live race is implemented but not reported as an executed result here.

## Consequences

Recovery code has an explicit durable lock-order rule. Future operations that need both outbox and recovery-request rows should follow the same order. This reduces a known lock-cycle risk; it is not a claim that arbitrary future database deadlocks are impossible.
