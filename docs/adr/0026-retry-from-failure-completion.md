# ADR 0026 — Schedule delivery retry from failure completion

## Status
Accepted in v0.0.83.

## Context
The dispatcher originally passed the batch claim timestamp into `markOutboxFailure`. That is correct only when a failed delivery returns immediately. If a downstream call takes longer than the retry delay, `nextAttemptAt` can already be in the past when the failure is recorded, so another worker can retry immediately and create a hot loop against a slow failing dependency.

## Decision
Production dispatch uses a clock at the point the delivery failure is observed. Equal-jitter backoff is added to that completion timestamp. Tests that need a fixed logical clock can still inject one.

## Evidence
A deterministic regression starts the claim at 01:00:00 and reports three failures at 01:00:05, 01:00:06 and 01:00:07. With a one-second retry delay, the durable retry timestamps are 01:00:06, 01:00:07 and 01:00:08 rather than 01:00:01.

## Consequence
Retry spacing now reflects time after a failed attempt actually completes. This does not replace request timeouts; a dependency that never returns must still be bounded at the sink/client layer.
