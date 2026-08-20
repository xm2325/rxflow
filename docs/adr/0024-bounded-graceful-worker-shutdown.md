# ADR 0024 — Bounded graceful shutdown for the outbox worker

## Status

Accepted in v0.0.80.

## Context

The worker previously stopped its polling timer on SIGTERM and then called `tick()` before closing the store. `BackgroundOutboxPublisher` used a process-local single-flight flag, so if a tick was already active, the shutdown-time `tick()` returned immediately. The process could then close the store while the active delivery or acknowledgement still used it.

This behavior is unsafe during rolling deploys and other cooperative process termination.

## Decision

`BackgroundOutboxPublisher` tracks the promise for its active tick and exposes `waitForIdle(timeoutMs)`.

On SIGTERM or SIGINT, the worker:

1. stops scheduling new polling ticks;
2. waits for an already-active tick up to a fixed deadline;
3. records a shutdown-drain timeout if that deadline expires;
4. closes the HTTP server and durable store after the wait.

The worker does not attempt to drain the entire queue during shutdown. Remaining unclaimed records stay pending for another worker.

## Consequences

Cooperative shutdown no longer closes the store underneath active publication. Shutdown time remains bounded, so a hung downstream dependency cannot block termination indefinitely.

This is not a replacement for durable leases. SIGKILL, machine failure, or a drain timeout can still leave in-flight records, which must become reclaimable after lease expiry.

## Evidence

The spawned v0.0.82 gate sends SIGTERM while a 350 ms webhook delivery is active. The worker exits after about 373 ms, one event is published before exit, three remain pending, zero remain in flight, and a replacement worker later reaches four published events.
