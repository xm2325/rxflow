# RxFlow v0.5.0 project evidence

RxFlow is an independent synthetic healthcare software-engineering project. This page separates executable local evidence from integration and deployment boundaries that are present only as code, configuration, or reference architecture.

## Executed locally

- Synthetic FHIR `MedicationRequest`/`Bundle`/`Task` workflow with PA assistance and human review.
- SQLite transaction, lease, multi-worker, recovery, ordering, and idempotency tests.
- Request/log data-boundary, dashboard security, operational-error, OpenAPI, dependency-lock, repository-hygiene, and public-surface checks.
- The complete local release gate and generated machine-readable release evidence.

## Implemented but not live-executed here

- PostgreSQL adapter, migrations, claim SQL, and PostgreSQL 17 CI scenario.
- GCP Pub/Sub REST publisher and authenticated push contract with injected/local tests.

## Reference-only or not integrated

- Cloud Run + Cloud SQL + Pub/Sub Terraform is a reference target, not an observed deployment.
- Epic and Surescripts are not integrated.
- The repository contains no real patient data, clinical deployment, or compliance certification.

Run `npm run demo:evidence` for a compact executable review path and `npm run release:check` for the full local gate. Machine-readable status is in [`evidence-boundaries.json`](evidence-boundaries.json).
