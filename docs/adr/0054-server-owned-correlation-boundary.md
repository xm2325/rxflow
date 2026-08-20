# ADR 0054 — Server-owned correlation boundary

## Context

RxFlow originally echoed any non-empty `X-Correlation-Id` supplied by a caller. The same value was persisted on cases/events and included in structured error logs. A caller could therefore place patient-identifying text in the correlation header and cause it to enter operational logs even though request bodies were otherwise kept out of error logging.

## Decision

The HTTP boundary accepts only opaque identifiers with machine-shaped syntax: a canonical UUID or a non-zero 32-hex trace identifier. Any other value is ignored and replaced with a server-generated UUID. The service still returns the effective value in `X-Correlation-Id`, so callers can use the response value for support/debugging.

This check is deliberately at the HTTP trust boundary. Internal tests and domain objects may use human-readable correlation labels because they do not represent untrusted external metadata.

## Evidence

`integration/request-boundary-smoke.mjs` sends a free-form correlation value containing a synthetic patient/MRN label, triggers request errors, and checks that the value does not appear in process output. A valid opaque UUID remains preserved and appears in the error log, so correlation remains operationally useful.

## Boundary

Syntax cannot prove that a random-looking identifier is semantically free of patient information. The rule reduces accidental leakage and rejects obvious free-form clinical identifiers; it is not a data-loss-prevention system.
