# ADR 0020 — synthetic SMART launch context boundary

## Status
Accepted for synthetic demo use.

## Context
An EHR-launched reviewer surface needs a way to bind the currently open patient to the RxFlow case. Treating an arbitrary patient query parameter as trusted would weaken the review boundary.

## Decision
RxFlow includes a small SMART App Launch context adapter that validates the EHR-launch `iss` and opaque `launch` inputs and extracts only launch context from a trusted token response. Access-token and ID-token strings are not retained. Before a case is shown in an EHR-launched review surface, the patient ID in the validated launch context must match the case patient reference. A mismatch uses not-found semantics.

## Limits
This is not an OAuth authorization-code implementation, token exchange, Epic integration, or production SMART client registration. It is a standards-aware synthetic context boundary used to demonstrate patient-context checks.
