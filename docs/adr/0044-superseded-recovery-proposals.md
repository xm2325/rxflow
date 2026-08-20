# ADR 0044 — Supersede stale recovery proposals on redrive

## Status

Accepted in v0.1.8 and released in v0.2.0.

## Context

A retirement proposal is created for one exact dead-letter `recoveryGeneration`. Before v0.1.8, redriving that event made the proposal impossible to approve safely, but the proposal still remained `PENDING`. Generation validation prevented the stale approval from mutating the newer failure cycle, yet the control-plane state was misleading: operators could still see an action that was no longer valid.

## Decision

`redriveDeadLetter` atomically changes all pending retirement proposals for `(tenantId, eventId, recoveryGeneration)` to `SUPERSEDED` in the same durable transaction that returns the event to `PENDING`. The transition records `supersededBy`, `supersededAt`, and a `RETIREMENT_SUPERSEDED` recovery-audit action.

A later failure increments `recoveryGeneration`. The blocked-aggregate view only associates a pending proposal with the current generation. A new failure cycle therefore requires a new proposal and a new two-person approval.

## Evidence

The spawned API/worker/webhook recovery gate creates a generation-1 proposal, redrives the event, observes that proposal as `SUPERSEDED`, lets the event fail as generation 2, proves no old proposal is shown as pending, creates a generation-2 proposal, and completes approval with a different platform principal.

## Consequences

Recovery lists now reflect actionable state rather than only relying on approval-time rejection. Historical proposals remain visible for audit instead of being deleted. Supersession does not mean the event was repaired or published; it only closes an obsolete control-plane proposal.
