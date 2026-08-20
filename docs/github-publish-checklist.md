# RxFlow v0.5.0 — GitHub publication checklist

## Before the first push

1. Run `npm ci` in a networked environment.
2. Run `npm run release:check` and confirm the generated run report and release-evidence JSON belong to v0.5.0.
3. Run `npm run demo:evidence` as the compact executable review path.
4. Confirm `package-lock.json` is committed and CI/Docker use `npm ci`.
5. Review `SECURITY.md`; do not add real patient data, real credentials, employer-confidential material, or private healthcare records.
6. Run `npm run check:surface` before publication.

## First GitHub Actions run

Watch the jobs separately. `release-gate` should clean-install dependencies and run the local release pipeline. `postgres-live` should start PostgreSQL 17, run `test:postgres:live`, and upload its evidence only after live integration succeeds.

Do not describe PostgreSQL as live-tested until a successful PostgreSQL CI result has been observed. Keep Cloud Run, Cloud SQL, Pub/Sub, Epic, and Surescripts within the limits recorded in `docs/evidence-boundaries.json`.

## After CI is green

Compare CI evidence with the committed release version and update `docs/evidence-boundaries.json` only when observed evidence changes. Synthetic timing experiments remain design tests, not production-performance measurements.
