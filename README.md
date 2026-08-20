# RxFlow

**Synthetic specialty-pharmacy workflow reliability platform**

RxFlow is an independent TypeScript/Node.js engineering project that models a specialty-pharmacy workflow from a FHIR `MedicationRequest` or Task-focused Bundle through benefits logic, prior-authorisation assistance, human review, routing, and durable integration-event delivery.

The project is designed around failure handling rather than a happy-path demo: tenant-scoped idempotency, optimistic concurrency, a transactional outbox, lease-based multi-worker dispatch, aggregate ordering, retry/backoff, dead-letter recovery, two-person destructive recovery approval, bounded operational errors, and audit-safe evidence boundaries.

**Data and deployment boundary:** RxFlow uses synthetic data only. It is not affiliated with an EHR vendor, payer, pharmacy network, healthcare provider, or employer. It does not integrate with Epic or Surescripts, has not processed real patient data, has not been clinically deployed, and is not a compliance certification. GCP infrastructure in `infra/gcp/` is a reference deployment target unless a specific CI evidence file says otherwise.

## v0.6.0

v0.6.0 reorganises the public engineering surface around executable contracts and modular tests. The current branch validates the restored core source on Node 22 and adds observed GitHub Actions evidence for:

- modular workflow, FHIR, outbox, and runtime-configuration tests;
- PostgreSQL 17 schema migration and live integration behaviour;
- container build, compiled-runtime load, and non-root execution;
- dependency audit and CycloneDX SBOM generation.

Observed CI evidence is kept under `docs/ci-evidence/`. A file in that directory is created only after the corresponding GitHub Actions gate completes successfully.

## 60-second review

```bash
npm ci
npm run build
npm test
```

For the explicit release contract:

```bash
npm run release:check
```

For the PostgreSQL live scenario, provide a disposable PostgreSQL 17 database:

```bash
RXFLOW_POSTGRES_TEST_URL=postgresql://rxflow:rxflow@127.0.0.1:5432/rxflow \
  npm run test:postgres:live
```

## Architecture

```text
FHIR MedicationRequest / Bundle
            │
            ▼
   tenant-scoped ingestion
   + idempotency fingerprint
            │
            ▼
       benefits logic
            │
       PA required?
        /        \
      no          yes
      │            │
      │       bounded PA draft
      │       + evidence checks
      │            │
      │       human review gate
      │            │
      └──────┬─────┘
             ▼
          routing
             │
             ▼
      transactional outbox
             │
     lease-based dispatcher
             │
   retry / ordering / DLQ
             │
             ▼
      external event sink
```

The API process and worker process are separate runtime roles. Durable state can use SQLite for local execution or PostgreSQL for shared multi-process execution. PostgreSQL queue ownership uses row locking and `SKIP LOCKED` semantics.

## Reliability contracts

### Idempotent ingestion

An idempotency key is tenant-local and bound to a request fingerprint. Replaying the same request returns the durable winner; reusing the key for a different payload fails closed.

### Human review and optimistic concurrency

Cases that require prior-authorisation support enter `HUMAN_REVIEW_REQUIRED`. Review decisions are versioned. A stale review cannot silently overwrite a newer case version.

### Transactional outbox

Case transitions and integration events are persisted together. Workers claim events with expiring leases, renew long-running claims, and use bounded retry/backoff. Ordered aggregate events cannot overtake unresolved predecessors.

### Dead-letter recovery

Dead-letter events carry a recovery generation. Operator actions must target the generation that was actually reviewed. Destructive gap-declaration recovery supports a two-person request/approval flow with durable recovery audit history.

### Data-minimised operational boundaries

Unexpected provider/database `Error.message` values are not treated as a public operational contract. Worker and API surfaces map unexpected failures to bounded codes instead of persisting arbitrary remote text.

## Repository layout

```text
src/                    core workflow, storage, API and worker runtime
integration/            live/runtime integration scenarios
test/                   modular executable contracts
fixtures/               synthetic FHIR fixtures
infra/gcp/               reference Cloud Run / Cloud SQL / Pub/Sub IaC
docs/                    architecture, ADRs and evidence boundaries
docs/ci-evidence/        observed CI evidence generated after passing gates
.github/workflows/       CI contracts
```

## Storage

`InMemoryCaseStore` is useful for deterministic tests, SQLite supports durable local/process scenarios, and `PostgresCaseStore` provides the shared-store implementation. The PostgreSQL schema is versioned and includes tenant-aware cases/idempotency, ordered outbox metadata, retirement requests, and recovery audit sequencing.

The GitHub Actions PostgreSQL gate uses PostgreSQL 17. That is execution evidence for the CI scenario, not a claim that a production PostgreSQL service is deployed.

## AI boundary

The included prior-authorisation generator is deterministic and synthetic. The AI abstraction demonstrates structured output validation, evidence grounding, timeouts, tracing metadata, and circuit-breaking. Human review remains mandatory before an assisted PA answer is treated as approved.

## Security boundary

The repository contains synthetic fixtures only. Authentication helpers, signed webhook support, bounded request sizes, structured operational errors, tenant isolation, and review separation-of-duties are engineering controls in this project; they do not constitute HIPAA, NHS DSPT, SOC 2, or any other compliance certification.

See `SECURITY.md` and `docs/project-evidence.md` for the explicit evidence boundary.

## Licence / use

This repository is a software-engineering demonstration using synthetic data. It is not medical advice and is not intended for direct clinical use.
