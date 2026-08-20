# ADR 0053 — Executable demo evidence

Status: Accepted in v0.3.0.

## Context

The project accumulated many useful failure gates, but reviewers should not need to discover the right commands before they can assess the main reliability properties.

## Decision

Add `npm run demo:evidence` as a compact command that re-runs the FHIR/PA human-review workflow, synthetic SMART patient binding, slow-tenant execution isolation, two-person ordered recovery, dashboard security, request/log data boundaries, and bounded operational-error checks. Keep a self-contained project page and architecture SVG for static review.

## Consequence

The project has a short executable evidence path without replacing the full `npm run release:check`. Timing output remains labelled synthetic, and the command reports explicit evidence limits so reference integrations are not presented as observed deployments.
