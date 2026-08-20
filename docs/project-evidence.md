# RxFlow project evidence

RxFlow is an independent synthetic healthcare software-engineering project. This document separates what has been observed in executable CI from what is implemented or described without a live deployment claim.

## Observed in GitHub Actions

For the v0.9.0 release-candidate branch, GitHub Actions has exercised the modular workflow/FHIR/outbox/configuration contracts, the review-governance state machine, workflow and outbox resilience paths, the full HTTP governance smoke, PostgreSQL 17 integration and review-governance routes, container build and non-root runtime checks, dependency audit/SBOM generation, Terraform formatting/initialisation/validation, and dedicated coverage gates for workflow governance and outbox reliability.

The current GitHub-native regression surface contains 75 tests. The workflow coverage gate requires at least 85% line coverage, 70% branch coverage, and 80% function coverage for `dist/src/workflow.js`; the observed GitHub Actions coverage is 88.80% lines, 75.90% branches, and 80.77% functions.

The outbox reliability gate is intentionally isolated to the combined 16-test `outbox-resilience` and `outbox-delivery-contract` surface rather than relying on the wider suite to lift coverage. It requires at least 80% line coverage, 70% branch coverage, and 85% function coverage for `dist/src/events.js`; the observed GitHub Actions coverage is 81.09% lines, 74.25% branches, and 88.57% functions.

The machine-readable status for these boundaries is maintained in `docs/evidence-boundaries.json`. A status of `executed-in-ci` means the corresponding contract has been observed on the GitHub Actions runner for this release-candidate line; it does not imply a production deployment.

## Review-governance boundary

The v0.9.0 workflow adds lease-bound review ownership, optimistic version checks, durable tenant-scoped decision idempotency, and a fail-closed second-approval route for low-confidence edited PA drafts. The second approval must be performed by a reviewer distinct from the first reviewer before the case can route.

The workflow resilience surface exercises PA dependency retry and terminal failure, containment of model output that attempts to skip review, stale human-review rejection, duplicate approval prevention, bounded reviewer corrections, operations-view data minimisation, and cross-instance idempotency races.

The PostgreSQL 17 CI scenario now directly exercises the same governance route against the PostgreSQL store: a reviewer claims the case, an edited low-confidence decision enters `SECOND_APPROVAL_REQUIRED`, exact decision replay resolves to the durable result, conflicting reuse of the same decision key fails closed, self-approval is rejected, a distinct second reviewer completes approval, second-approval replay resolves durably, and the routed case retains the first reviewer, second reviewer, final answer, and review receipts after a fresh store read. Tenant isolation is checked again on the persisted case. This is execution evidence from a disposable PostgreSQL 17 GitHub Actions service container, not evidence of a production PostgreSQL deployment.

## Outbox-reliability boundary

The outbox resilience surface exercises lease heartbeat protection against cross-worker reclamation, retry timing from failure completion, fair tenant interleaving, tenant-scoped throttling, global dependency short-circuiting, aggregate-head ordering, terminal-head redrive, stale dead-letter recovery-generation rejection, cross-tenant delivery concurrency, and preservation of already in-flight deliveries during a global outage.

The delivery-contract surface additionally checks invalid dispatcher bounds, integration-event parsing and canonical egress, first-attempt dead-lettering of non-retryable failures, durable retry-after floors, poison-event containment, and sequential delivery within a single tenant lane under cross-tenant concurrency.

## Implemented boundaries

The codebase contains tenant-scoped ingestion idempotency, transactional outbox persistence, lease-based dispatch, aggregate ordering, dead-letter recovery, two-person destructive recovery approval, bounded operational errors, FHIR ingestion helpers, and PostgreSQL/SQLite storage implementations.

SQLite multi-process concurrency remains `executed-local`; it is not promoted to `executed-in-ci` by the v0.9.0 evidence registry.

## Reference-only infrastructure

`infra/gcp/` describes a reference Cloud Run / Cloud SQL / Pub/Sub target. It is a reference target, not an observed deployment. Successful Terraform formatting, initialisation, and validation show that the reference configuration is syntactically/provider-valid; they are not evidence that a live GCP environment has been deployed.

## Explicit non-claims

Epic and Surescripts are not integrated. The project uses synthetic fixtures only and contains no real patient data. It is not a clinical deployment, and no HIPAA, NHS DSPT, SOC 2, or other compliance certification is claimed.

Synthetic fixtures and CI scenarios are used to exercise engineering contracts without representing a production healthcare deployment.
