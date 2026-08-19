# ADR 0048 — Do not let idle probe sockets extend worker shutdown

## Decision

After stopping new ticks and waiting for the active publisher, close the worker HTTP listener and explicitly close idle keep-alive connections before closing storage.

## Reason

A release run measured roughly one second of shutdown around a 350ms synthetic webhook even though the active publication had completed. Health/metrics keep-alive sockets are not durable work and should not extend rolling-deployment termination.

## Safety boundary

The worker still waits for the active publisher before closing storage. Abrupt process/node failure is still handled by claim leases and downstream event-ID deduplication; this ADR only changes graceful termination.

## Evidence

The spawned SIGTERM gate requires the 350ms active delivery to be acknowledged, requires zero `IN_FLIGHT` rows after exit, and rejects shutdown tails of 900ms or more.
