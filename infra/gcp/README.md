# GCP reference deployment

This directory maps the tested RxFlow interfaces to a Cloud Run API + separate Cloud Run outbox worker + Cloud SQL for PostgreSQL + Pub/Sub topology. It is a reference configuration, not evidence that this repository has been deployed to a live GCP project.

## Process split

The API owns request/clinical workflow transactions only. It uses `RXFLOW_EXTERNAL_OUTBOX_WORKER=true` and `RXFLOW_PUBLISH_INTERVAL_MS=0`, so it cannot publish an outbox event from request handling, startup, shutdown, or a timer. The worker runs `dist/src/worker-server.js`, shares the PostgreSQL outbox, and is the only runtime granted Pub/Sub publisher IAM.

This separation fixes a failure mode found after v0.0.72: the configuration flag said an external worker existed, but request-triggered API code could still call the in-process publisher. The spawned two-process smoke gate now proves that events remain pending while the worker is absent, drain when it starts, remain pending again after it stops, and recover after worker restart.

## What the reference wires

- Cloud SQL for PostgreSQL 17, a database, and application user.
- Cloud SQL Unix sockets mounted at `/cloudsql` in API, worker, and migration job.
- Secret Manager injection for `RXFLOW_PGPASSWORD`.
- Separate API and worker service accounts with Cloud SQL access.
- Pub/Sub publisher permission only for the worker service account.
- API CPU may idle and reference minimum instances may be zero because it has no background delivery loop.
- Worker CPU remains allocated and at least one worker instance stays warm for queue progress.
- The worker reference enables bounded cross-tenant delivery concurrency (`RXFLOW_OUTBOX_TENANT_DELIVERY_CONCURRENCY`) so a slow tenant sink does not hold the only execution slot; the reference value is a deployment example, not production capacity tuning.
- Pub/Sub topic, retry/dead-letter subscription, and Google service-agent permissions.
- A Cloud Run migration job that runs `dist/src/migrate-postgres.js` before API/worker revisions requiring a newer schema.
- Verify-only schema startup for normal API and worker processes.

## Initial rollout order

Run the migration job before shifting API or worker traffic to a revision that requires the new schema:

```bash
gcloud run jobs execute rxflow-api-migrate --region europe-west2 --wait
```

Then deploy/update the worker and API revisions and verify their readiness endpoints.

## Security and cost boundaries

The API service account is intentionally not a Pub/Sub publisher. The worker service has the extra publisher permission because delivery is its job. Worker ingress is internal-only in the reference. Real deployment should also set explicit Cloud Run IAM/invoker policy and monitoring outside this repository.

The generated database password is written to Secret Manager, but Terraform also tracks generated values in state. A real environment therefore needs protected remote Terraform state or a separately managed database-credential lifecycle.

`RXFLOW_TRUST_PLATFORM_IAM=true` on the API means the reference delegates request authentication to Cloud Run IAM. This does not prove tenant-aware identity mapping in a deployed environment. The repository's static credential mode remains a local demonstration of tenant/role separation.

The Cloud SQL instance is ZONAL by default to keep this reference cheaper. Availability, deletion protection, networking, backup retention, sizing, and disaster recovery must be selected for the target environment before treating this as a production design.

## Validation boundary

`npm run check:infra` checks the repository contract between Terraform and runtime configuration. `npm run test:worker:smoke` executes API/worker process separation locally against one SQLite WAL database. GitHub Actions is intended to run Terraform format/validate and the PostgreSQL service-container job. This sandbox has no Terraform binary, Docker daemon, GCP project, or live PostgreSQL service, so no successful GCP apply, container build, or live Cloud SQL connection is claimed here.
