# ADR 0025 — Integration-event schema v2 and staff-identity minimisation

## Status

Accepted in v0.0.82.

## Context

`PaApproved` schema v1 included the reviewer principal in the generic integration-event payload. Internal case and audit state require reviewer attribution, but generic downstream delivery does not require the pharmacist identity to route the prescription.

Removing the field from schema v1 in place would be unsafe because durable outbox records can remain pending across a deployment. A newer worker must still be able to process persisted older events.

## Decision

New integration events use `schemaVersion = 2`.

The runtime parser accepts both schema v1 and schema v2 and rejects unsupported versions.

For `PaApproved`:

- schema v1 continues to require `reviewer` and `edited`;
- schema v2 carries `edited` but omits the reviewer principal.

Reviewer identity remains in the internal review decision and audit trail, where it is required for attribution.

## Consequences

New generic events carry less staff identity while old durable backlog remains readable during a rolling transition.

Consumers can branch on an explicit schema version rather than inferring shape from optional fields. A later incompatible event change can follow the same versioned transition pattern.

This change reduces unnecessary data propagation; it is not a compliance certification.

## Evidence

The v0.0.82 automated suite verifies that a schema-v1 `PaApproved` event still parses, newly generated events use schema v2 without a reviewer field, and unsupported schema versions are rejected.
