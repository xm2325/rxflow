# ADR 0057 — Evidence-first release orchestration

## Context

RxFlow had accumulated many process-level gates. The old `release:check` first ran `npm test` and then ran the complete automated suite again under Node coverage. It also depended on manually copied test counts and coverage percentages in public documents. That produced two separate problems: unnecessary release latency and a real risk that a functional release could pass while public evidence drifted.

## Decision

The release runner now compiles once, runs the automated suite once under the coverage thresholds, reuses the compiled output for all remaining process/contract gates, and records each successful gate as machine-readable JSON evidence. After the executable gates pass it writes `docs/release-evidence-v<version>.json`; the documentation contract reads that file and checks current test-count and coverage claims before the release can finish.

GitHub uploads the local release evidence as a CI artifact. The separate PostgreSQL-17 job writes its own `postgres-live-evidence.json` only after the live service-container scenario reaches the success path. This keeps “the CI scenario exists” separate from “the live database scenario was observed to pass.”

## Consequences

The local release runner is shorter and easier to inspect, but it deliberately captures gate summaries rather than treating console timing as a production benchmark. A missing npm lockfile, PostgreSQL server, Docker binary, Terraform binary, or cloud deployment remains a visible evidence gap. `npm run doctor` reports those capabilities without turning absence into a passing integration claim.
