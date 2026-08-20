# ADR 0055 — JSON media type and bounded idempotency contract

## Context

The API previously parsed JSON regardless of the declared `Content-Type`, and `X-Idempotency-Key` accepted arbitrary strings. That makes the integration boundary less explicit and permits oversized or free-form request metadata to become durable database keys.

## Decision

FHIR ingestion accepts `application/json` and `application/fhir+json`; other JSON-body routes accept `application/json`. Explicit non-UTF-8 JSON is rejected with HTTP 415. A declared `Content-Length` above the 1 MiB body limit is rejected before body accumulation; streamed requests retain the existing incremental byte limit.

External idempotency keys must be 8–128 character opaque tokens using a constrained ASCII alphabet. Missing keys remain supported because RxFlow can derive the synthetic fallback key from the FHIR resource identifier.

## Evidence

Pure contract tests cover media type, charset, `Content-Length`, and idempotency-key boundaries. The spawned request-boundary gate verifies HTTP 415 for `text/plain`, HTTP 400 for a free-form idempotency value, and HTTP 201 for FHIR JSON with UTF-8.

## Boundary

RxFlow does not claim full FHIR conformance from media-type validation. The allowed idempotency syntax also cannot establish that a token was generated randomly; callers are instructed to keep patient data out of request metadata.
