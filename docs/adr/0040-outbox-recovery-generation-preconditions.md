# ADR 0040 — Dead-letter recovery is generation-conditioned

## Problem

An event may dead-letter, be redriven, and dead-letter again with the same stable event ID. An operator who reviewed the first failure must not apply a retirement/redrive decision to the later failure cycle.

## Decision

Each transition into `DEAD_LETTER` increments durable `recoveryGeneration`. Dead-letter views return a recovery ETag `"outbox-<eventId>-gN"`. HTTP redrive/retire require `If-Match`; missing input returns 428 and a stale generation returns 412.

## Storage

SQLite and PostgreSQL persist the generation. PostgreSQL schema version 6 verifies the column.
