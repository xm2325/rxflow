# ADR 0060 — Lock the TypeScript build tool

## Status
Accepted in RxFlow v0.5.0.

## Context
RxFlow added a package lock and moved CI/container installs to `npm ci`, but both GitHub Actions and the Docker build stage still ran `npm install -g typescript@5.8.3`. The compiler version was written down, yet it remained outside the package lock and required a second installation step. The runtime dependency graph was therefore more reproducible than the build graph.

## Decision
Pin `typescript` to exact version `5.8.3` in `devDependencies` and include the integrity-bearing npm registry entry in lockfile v3. Remove all global TypeScript installation from CI and Docker. Build stages install dev dependencies with `npm ci`; the runtime image continues to use `npm ci --omit=dev`.

`check:dependencies` validates the manifest, root lock entry, `node_modules/typescript` lock entry, CI workflow, and Dockerfile as one contract. Reproducibility tests reject a return to global compiler installation.

## Consequences
A clean networked `npm ci` now defines both runtime and TypeScript build-tool versions. This sandbox can validate the lock structure with `npm install --package-lock-only --offline`, but cannot prove a clean offline install because not all registry tarballs are cached. Live CI remains the evidence source for clean installation.
