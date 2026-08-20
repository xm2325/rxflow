# ADR 0038 — Fresh claim time for each dispatcher wave

## Status

Accepted in RxFlow v0.1.2.

## Problem

Ordered aggregate delivery introduced multi-wave dispatch: a worker publishes the current aggregate head, then claims the next head in another wave during the same drain.

The first implementation reused the first wave's claim timestamp for later waves. A real process test used a 150 ms lease and a 260 ms downstream response. By the time wave 2 claimed its event, the persisted lease was calculated from an old timestamp and was already expired. A second worker reclaimed later sequence events and the receiver observed seven transport deliveries for four unique events.

## Decision

When `drain()` runs against the real clock, every wave obtains a fresh timestamp immediately before claiming. An explicitly supplied `now` remains fixed for deterministic unit tests.

Lease heartbeats remain in place for slow deliveries after a valid claim. The two controls solve different problems:

- fresh wave time prevents a new claim from starting with an already-expired lease;
- heartbeat renewal keeps a valid claim alive while delivery remains slow.

## Evidence

After the change, the same spawned two-worker slow-delivery test reports:

- four unique events;
- four transport deliveries;
- zero duplicate transport deliveries;
- lease renewals during the 260 ms receiver delay.

A separate unit test advances an injected clock between successful waves and verifies that later claims use the newer time.
