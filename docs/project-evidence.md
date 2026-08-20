# RxFlow project evidence

RxFlow is an independent synthetic healthcare software-engineering project. This document separates what has been observed in executable CI from what is implemented but not deployed.

## Executed in GitHub Actions

The current v0.6.0 repair/upgrade branch records successful evidence files under `docs/ci-evidence/` only after the corresponding gate completes. The observed contracts include modular workflow/FHIR/outbox/configuration tests, PostgreSQL 17 live integration, container runtime checks, and dependency/SBOM checks when their evidence files are present.

## Implemented boundaries

The codebase contains tenant-scoped idempotency, optimistic concurrency, transactional outbox persistence, lease-based dispatch, aggregate ordering, dead-letter recovery, two-person destructive recovery approval, bounded operational errors, FHIR ingestion helpers, and PostgreSQL/SQLite storage implementations.

## Reference-only infrastructure

`infra/gcp/` describes a reference Cloud Run / Cloud SQL / Pub/Sub target. It is a reference target, not an observed deployment. Repository infrastructure code or successful Terraform validation is therefore not evidence that a live GCP environment has been deployed.

## Explicit non-claims

Epic and Surescripts are not integrated. The project uses synthetic fixtures only and contains no real patient data. It is not a clinical deployment, and no HIPAA, NHS DSPT, SOC 2, or other compliance certification is claimed.

Synthetic fixtures and CI scenarios are used to exercise engineering contracts without representing a production healthcare deployment.
