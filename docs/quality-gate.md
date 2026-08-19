# RxFlow v0.5.0 source quality gate

The local unit suite now has a source-only coverage gate in addition to the process-level integration gates.

Run:

```bash
npm run test:coverage:core
```

The gate measures `dist/src/*.js`, excludes CLI/demo/check entry points, and excludes `postgres-store.js` from the **local** threshold because PostgreSQL has a separate PostgreSQL-17 service-container CI job. The exclusion is an evidence boundary, not a claim that PostgreSQL does not require coverage.

Minimum local core thresholds:

- lines: 90%
- branches: 75%
- functions: 85%

The thresholds are intentionally below 100%. RxFlow uses failure-injection and process-level checks for distributed behavior that line coverage cannot prove. Coverage is used to detect silent regression in exercised source paths, not as a substitute for concurrency, crash-recovery, security, or contract tests.

v0.3.3 added explicit edge-path tests for malformed FHIR inputs, Coverage-class fallback, work-queue priority and data minimisation, safe internal-error conversion, GCP metadata failure/cache invalidation, invalid Pub/Sub identifiers, authenticated consumer error mapping, runtime AI wrapping, and runtime store selection.

## v0.4.7 request-boundary additions

The local core also covers `http-request-contract.ts`. Exact observed coverage is release-generated and intentionally kept out of this stable document because V8 branch accounting can vary by a small fraction across otherwise identical local runs. The separate spawned request-boundary gate is intentionally not reduced to line coverage: it captures a real child process and checks that synthetic patient, clinical-note, and unsafe correlation sentinels do not appear in process logs.

## v0.4.7 evidence-first release runner

`npm run release:check` now performs one TypeScript build and one coverage-enabled execution of the automated test suite. It then reuses the compiled `dist/` tree for the process and contract gates. The successful run writes `docs/release-evidence-v0.4.7.json` and `artifacts/release-evidence-v0.4.7.json` with the observed test totals, coverage result, gate summaries, and explicit evidence limitations. `check:docs` reads that file and rejects drift in the README, run report, portfolio test count, and quality-gate coverage claim.

The evidence runner is intentionally not a production benchmark recorder. Synthetic timing fields can appear in individual gate summaries, but the evidence file marks the release as local and synthetic, and public documentation does not treat those timings as deployed-system performance.

## v0.4.7 dependency-lock gate

The repository now commits `package-lock.json` and checks it as executable release evidence. The dependency gate requires the root release/version and exact `pg` 8.16.3 dependency to match `package.json`, requires every locked package to carry an npm-registry URL plus sha512 integrity metadata, and requires both CI and the production container to use `npm ci`. `npm install --package-lock-only --offline` accepts the lockfile in this sandbox; a full offline clean install cannot complete because the dependency tarballs are not cached, so local clean-install success is not claimed.

## v0.4.7 repository-surface gate

Generated run reports and machine evidence are release artifacts, not long-term source history. The repository keeps only the current generated evidence at the top-level docs surface; engineering history remains in the changelog, failure-driven record, and ADRs. The repository-hygiene gate also checks `.gitignore`, `.dockerignore`, the synthetic-data security boundary, README quick evidence commands, and a small set of obvious secret-shaped token patterns.

## Public repository surface

The release also runs `npm run check:surface`. Public relative links must resolve, and repository text is scanned for a bounded set of obvious secret-shaped tokens. This is a publication-hygiene check, not a general secret-scanning or compliance claim.


## v0.4.7 operational-error gate

`npm run check:operational-errors` checks that the API, worker, consumer, and dispatcher keep unexpected exception messages behind bounded operational codes. The automated suite also injects synthetic clinical text as an unexpected sink error and verifies that the text is absent from durable outbox state and dead-letter operations views.


## v0.5.0 locked TypeScript build tool

The first lockfile release still installed `typescript@5.8.3` globally in GitHub Actions and the Docker build stage. That meant the compiler was not controlled by `package-lock.json`, so two nominally identical installs could still use a build tool outside the locked graph. TypeScript is now an exact dev dependency, its registry integrity is present in lockfile v3, and both CI jobs plus Docker use only `npm ci`. `check:dependencies` rejects a missing/changed TypeScript lock entry or any return of `npm install -g typescript`. `npm install --package-lock-only --offline` validates the lock structure in this sandbox; a clean `npm ci` still requires uncached registry tarballs.
