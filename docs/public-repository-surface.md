# RxFlow v0.5.0 public repository surface

This document records checks used before public GitHub publication. The goal is to make the repository easy to inspect without treating repository hygiene as a security or compliance claim.

## Executable checks

`npm run check:surface` validates local Markdown/HTML references and scans repository text for a bounded set of obvious secret-shaped tokens. Generated build output, local artifacts, dependency directories, and tests that intentionally contain secret sentinels are excluded.

## What the check does not prove

This is not a full secret-scanning product, data-loss-prevention system, dependency-vulnerability scan, or compliance control. A public repository should still use GitHub secret scanning, protected credentials, dependency alerts, and human review.

## Publication boundary

The repository remains a synthetic software-engineering project. A successful surface check does not mean the project has been deployed, connected to Epic or Surescripts, or run against real patient data.
