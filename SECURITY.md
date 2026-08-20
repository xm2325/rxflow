# RxFlow security policy

RxFlow is a synthetic portfolio project. Do not submit real patient information, production credentials, real access tokens, private keys, or proprietary healthcare records to this repository or its demo endpoints.

## Supported security boundary

The repository contains engineering controls such as separate ingestion/operations/reviewer credentials, bounded request metadata, data-minimised operations views, strict dashboard CSP, signed/authenticated integration boundaries, and synthetic sentinel tests for process-log leakage. These controls are software-engineering evidence; they are not a compliance certification or a claim of clinical deployment.

## Reporting a problem

For a public copy of this project, report security-sensitive defects privately to the repository owner rather than placing secrets or patient-like data in a public issue. Use a synthetic reproduction whenever possible.

## Test data rule

Fixtures and examples must remain synthetic. If a proposed reproduction resembles a real healthcare record, replace names, identifiers, clinical notes, payer data, and prescription details with invented values before committing it.
