# ADR 0027 — Canonicalise events before external delivery

## Status
Accepted in v0.0.84.

## Context
Runtime event validation allowed extra scalar payload fields for forward compatibility. That meant a durable internal event could accidentally contain extra operational or clinical text and still be sent by a generic sink. Schema-v1 `PaApproved` backlog could also retain reviewer identity even though schema v2 intentionally removed it.

## Decision
The dispatcher now reconstructs an external event from an explicit per-event allow-list before calling an event sink. Unknown payload fields are removed. Legacy `PaApproved` v1 is upgraded to v2 only when the non-identifying `edited` flag exists; otherwise delivery fails closed and follows the normal retry/dead-letter path.

## Evidence
Tests verify that accidental `patientReference`, clinical text and reviewer fields do not reach a collecting sink, while the stable `eventId`, tenant/correlation metadata and required business fields remain intact. A v1 approval missing `edited` is dead-lettered rather than exported with reviewer identity.

## Consequence
The durable outbox can remain backward-readable while the external trust boundary has a smaller contract. Event producers and external consumers should rely only on the documented canonical payload.
