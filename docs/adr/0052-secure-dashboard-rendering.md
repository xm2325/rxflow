# ADR 0052 — Secure local dashboard rendering

Status: Accepted in v0.3.0.

## Context

The local operations dashboard rendered API values with HTML-string templates. Several displayed values ultimately originate from FHIR input, so a synthetic or malformed medication code could contain markup. The dashboard CSP also allowed `unsafe-inline`, which weakened the browser boundary.

## Decision

Move CSS and JavaScript into same-origin assets, remove `unsafe-inline` from the CSP, add `object-src 'none'`, and build dynamic UI values with DOM nodes and `textContent`. Keep clinical approval out of this operations dashboard.

Add both a source regression and a spawned-server contract. The latter ingests an intentionally HTML-shaped medication-code sentinel through the real FHIR path and confirms the dashboard uses the hardened rendering contract.

## Consequence

The development dashboard remains a lightweight portfolio surface, not a production frontend framework claim. It is safer to review locally and makes the operations data boundary visible without expanding the clinical surface.
