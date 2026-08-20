# RxFlow project evidence

RxFlow is an independent synthetic healthcare software-engineering project. This document separates what has been observed in executable CI from what is implemented or described without a live deployment claim.

## Observed in GitHub Actions

For the v0.9.0 release-candidate branch, GitHub Actions has exercised the modular workflow/FHIR/outbox/configuration contracts, the review-governance state machine, the full HTTP governance smoke, PostgreSQL 17 live integration, container build and non-root runtime checks, dependency audit/SBOM generation, and Terraform formatting/initialisation/validation.

The machine-readable status for these boundaries is maintained in `docs/evidence-boundaries.json`. A status of `executed-in-ci` means the corresponding contract has been observed on the GitHub Actions runner for this release-candidate line; it does not imply a production deployment.

## Review-governance boundary

The v0.9.0 workflow adds lease-bound review ownership, optimistic version checks, durable tenant-scoped decision idempotency, and a fail-closed second-approval route for low-confidence edited PA drafts. The second approval must be performed by a reviewer distinct from the first reviewer before the case can route.

## Implemented boundaries

The codebase contains tenant-scoped ingestion idempotency, transactional outbox persistence, lease-based dispatch, aggregate ordering, dead-letter recovery, two-person destructive recovery approval, bounded operational errors, FHIR ingestion helpers, and PostgreSQL/SQLite storage implementations.

SQLite multi-process concurrency remains `executed-local`; it is not promoted to `executed-in-ci` by the v0.9.0 evidence registry.

## Reference-only infrastructure

`infra/gcp/` describes a reference Cloud Run / Cloud SQL / Pub/Sub target. It is a reference target, not an observed deployment. Successful Terraform formatting, initialisation, and validation show that the reference configuration is syntactically/provider-valid; they are not evidence that a live GCP environment has been deployed.

## Explicit non-claims

Epic and Surescripts are not integrated. The project uses synthetic fixtures only and contains no real patient data. It is not a clinical deployment, and no HIPAA, NHS DSPT, SOC 2, or other compliance certification is claimed.

Synthetic fixtures and CI scenarios are used to exercise engineering contracts without representing a production healthcare deployment.
