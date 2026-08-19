# ADR 0012: Persist retry eligibility in the outbox

Status: accepted

Explicit sink failures should not return to an immediately claimable state on every publisher timer tick. Failed records can store `nextAttemptAt` using bounded exponential backoff. Claim queries skip future records; success and dead-lettering clear the retry timestamp.

Lease expiry remains separate from delivery failure and permits immediate reclaim because the system does not know whether a delivery attempt occurred.
