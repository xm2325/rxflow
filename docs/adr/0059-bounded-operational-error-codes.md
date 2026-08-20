# ADR 0059 — Bounded operational-error codes

## Status
Accepted in RxFlow v0.4.7.

## Context
RxFlow already prevented synthetic FHIR/body sentinels from appearing in API process logs. That control did not cover a different path: an arbitrary library, database, or downstream exception can carry free-form text in `Error.message`. Persisting that text to the transactional outbox, exposing it through worker metrics, or copying it into consumer logs would turn exception text into an implicit telemetry/data contract.

## Decision
Expected failures created by RxFlow adapters keep bounded machine codes because the dispatcher needs them for retry and failure-scope policy. Unexpected delivery exceptions collapse to `delivery_internal_error` before `markOutboxFailure`. Unexpected worker-loop and consumer failures use `outbox_worker_internal_error` and `consumer_internal_error`. The API already maps unknown exceptions through `asAppError` to `internal_error`.

The source contract `npm run check:operational-errors` rejects direct production-entrypoint logging of raw `error.message`. Tests inject clinical-looking sentinel text into unexpected exceptions and verify that durable outbox state and dead-letter operations views do not retain it.

## Consequences
Operators lose raw exception strings from these generic paths. Provider-specific diagnostics must therefore be obtained through deliberately designed, data-minimised adapter telemetry rather than by copying arbitrary exception messages. This is a local application control, not a claim about cloud log retention, DLP, or regulatory compliance.
