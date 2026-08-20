# ADR 0051 — Rotate tenant lanes after each delivery attempt

## Status

Accepted in v0.2.5.

## Context

A concurrency scheduler that gives a slot to an entire tenant lane can recreate noisy-neighbour delay when active tenants outnumber available slots. A tenant with a large claim quantum can retain one slot for many sequential calls.

## Decision

A concurrency slot is held for one external attempt. After a record finishes, a healthy tenant lane moves to the back of the ready queue. At most one record from that tenant is active at a time.

## Consequences

This keeps execution scheduling aligned with tenant-fair claim intent and prevents a claim quantum from becoming an execution quantum. It also makes the one-slot behavior deterministic enough to test as tenant order `A,B,C,A`.
