# CI and quality gates — v0.5.0

`npm run release:check` is the local release gate. v0.4.7 replaces the older duplicate test execution with an evidence-first runner:

1. Compile TypeScript once.
2. Run the **258-test** suite once under the local-core coverage gate.
3. Reuse the compiled output for workflow, AI, queue, HTTP, process, security, OpenAPI, infrastructure, and CI-contract gates.
4. Write a machine-readable `docs/release-evidence-v0.4.7.json` only after those executable gates pass.
5. Run the documentation contract last; it reads the evidence file and rejects stale test-count or coverage claims.

GitHub CI uploads that release-evidence JSON as an artifact. The PostgreSQL-17 service-container job writes and uploads `artifacts/postgres-live-evidence.json` only after the real database scenario reaches its success path. The current sandbox still has no PostgreSQL server, so the CI harness is not presented as a locally observed PostgreSQL result.

The process gates intentionally test different failure modes: API/worker separation, multi-process ownership, sender-crash redelivery, renewable leases, global-outage containment, tenant fairness/throttling/concurrency, queue-age objectives, ordered/two-person recovery, bounded shutdown, dashboard rendering security, and request/log data boundaries. `check:ci` also machine-checks that the release and PostgreSQL evidence artifact paths remain present in the GitHub workflow.

`npm run doctor` reports local evidence readiness (Node/npm/TypeScript, lockfile, `pg`, PostgreSQL client, Docker, Terraform, and live PostgreSQL URL) without converting missing optional tools into a passing integration claim.

## v0.1.2 ordered-stream gate

The release gate also starts a real worker process and webhook receiver, terminally rejects sequence 1 of one aggregate, verifies that sequence 2+ cannot overtake it, lets an unrelated aggregate finish, redrives the exact dead-letter head, and verifies ordered recovery. The two-worker slow-delivery gate remains in the release chain because it caught the stale multi-wave claim-time bug introduced while adding ordered advancement.


## v0.2.0 recovery lifecycle evidence

The aggregate-recovery process gate now exercises two failure generations. It creates a generation-1 retirement proposal, redrives the event, proves that proposal becomes `SUPERSEDED`, observes a generation-2 dead letter, creates a new proposal, and completes two-person approval. The recovery-history API must return causal audit sequences `[1,2,3,4,5]`.

The PostgreSQL 17 live-CI script also contains a concurrent approval-versus-redrive race with a five-second timeout and rejects `40P01`/deadlock results. This is a CI scenario, not an observed PostgreSQL result in the current sandbox.


## v0.3.3 concurrency evidence checks

- `slow-tenant-concurrency-smoke.mjs` runs two real worker-process phases against the same 200ms-vs-10ms tenant latency shape and requires a material fast-tenant latency reduction at concurrency 2.
- `global-outage-concurrency-smoke.mjs` proves shared-failure fan-out is bounded by tenant concurrency: two calls may already be active, untouched claims are deferred without attempt cost, and the queue fully recovers.
- Unit tests prove same-tenant delivery remains serial, the configured concurrency is validated, and tenant lanes rotate record-by-record rather than holding a slot for their full claim quantum.
- `check:infra` requires the Terraform worker reference to carry the tenant-delivery concurrency setting separately from the claim quantum.

## v0.2.3 evidence-integrity checks

- The tenant-throttle process gate uses four independent throttled aggregates so tenant-scope short-circuit/defer behavior is measured rather than inferred from ordered followers that were never claim-eligible.
- The late-arrival process gate asserts `activePublication=true` when deliveries are in progress even if completed-tick `claimed` counters have not yet advanced.
- The graceful-shutdown process gate requires the active 350ms delivery to complete, requires no event to remain `IN_FLIGHT`, and rejects an extra idle-HTTP shutdown tail of 900ms or more.

## v0.3.3 application-release checks

`release:check` now also runs `integration/dashboard-contract.mjs`. The dashboard contract verifies same-origin external CSS/JavaScript, a CSP without `unsafe-inline`, DOM text-oriented rendering, `Cache-Control: no-store`, and a real FHIR ingest path carrying an HTML-shaped sentinel. `npm run demo:evidence` is intentionally separate from the full release gate: it is a short curated command for an reviewer, not a substitute for the complete suite.

The release-document contract also checks `docs/portfolio.html` and `docs/project-evidence.md` against the runtime version.

## v0.3.3 source coverage gate

`npm run test:coverage:core` uses Node 22's test coverage support and applies local-core minimums of 90% lines, 75% branches, and 85% functions. Exact observed coverage is generated into the current run report/evidence rather than copied into this stable CI description. `postgres-store.js` is excluded from the local threshold because live PostgreSQL behavior is assigned to the separate PostgreSQL-17 CI job; the repository does not use that exclusion to claim PostgreSQL execution in this sandbox.


## v0.4.7 request-boundary gate

`integration/request-boundary-smoke.mjs` starts the compiled API with a fresh SQLite database, tests JSON/FHIR media types and idempotency metadata, captures child-process output, and checks that synthetic patient/clinical values plus a rejected free-form correlation identifier do not enter stdout/stderr. `release:check` executes this gate after the dashboard contract.

## v0.4.7 deterministic dependency installation

`package-lock.json` is now committed and GitHub jobs use `npm ci --ignore-scripts --no-audit --no-fund` before building. The Docker runtime also copies the lockfile and uses `npm ci --omit=dev`. `npm run release:check` runs a dependency-lock contract even in an offline environment, so release/version drift, missing integrity metadata, or a regression back to unlocked `npm install` fails locally before CI.

- `check:surface` validates public local references and a bounded secret-pattern scan before publication.


## v0.5.0 locked TypeScript build tool

The first lockfile release still installed `typescript@5.8.3` globally in GitHub Actions and the Docker build stage. That meant the compiler was not controlled by `package-lock.json`, so two nominally identical installs could still use a build tool outside the locked graph. TypeScript is now an exact dev dependency, its registry integrity is present in lockfile v3, and both CI jobs plus Docker use only `npm ci`. `check:dependencies` rejects a missing/changed TypeScript lock entry or any return of `npm install -g typescript`. `npm install --package-lock-only --offline` validates the lock structure in this sandbox; a clean `npm ci` still requires uncached registry tarballs.
