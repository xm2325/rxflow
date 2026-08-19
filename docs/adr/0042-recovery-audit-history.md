# ADR 0042 — Durable recovery audit history

## Context

Redrive and destructive recovery change durable event state. Process logs can be incomplete after restart and are not the authoritative record of who changed that state.

## Decision

Persist recovery audit entries for redrive, retirement request and retirement approval. Store actor, action, tenant/event identity, recovery generation, timestamp and bounded reason/reference metadata. Do not copy event payloads, patient references or clinical text. Expose actor-level history only to the platform role.

## Consequences

Recovery evidence survives process restarts and stays tied to the durable event state. The audit table is intentionally not a general clinical audit log.
