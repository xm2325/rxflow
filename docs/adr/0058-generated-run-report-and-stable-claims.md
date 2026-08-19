# ADR 0058 — Generated run reports and stable public claims

## Context

The first evidence-runner release still copied exact coverage values into the README and portfolio. Two successful local executions produced the same line/function coverage but a 0.01-point difference in V8 branch coverage. That difference did not indicate a meaningful change in RxFlow behavior, yet a documentation contract based on exact static coverage text would either become brittle or stop checking the values that mattered.

## Decision

Exact observed test and coverage results belong to the machine-generated release evidence and run report. Stable public documents state the enforced thresholds and link to the generated evidence rather than repeating volatile measurements. The release runner writes the run report before the documentation contract executes. `check:docs` then verifies that the generated report contains the exact test total and all three exact coverage measurements from the evidence file.

The environment doctor is also included in release evidence. Missing `package-lock.json`, PostgreSQL, Docker, Terraform, or `pg` runtime support remains visible as a limitation instead of being inferred from source/configuration presence.

## Consequences

The repository keeps precise per-run evidence without turning small tooling variation into public-document drift. A successful release can still fail if its generated report and evidence disagree, while README/portfolio claims remain stable across valid runs. The generated report is not a production benchmark and does not establish live PostgreSQL or cloud deployment.
