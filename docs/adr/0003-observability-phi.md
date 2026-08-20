# ADR 0003: PHI-safe operational observability

Operational logs use an allowlisted shape: event name, error code, HTTP status, and correlation ID. Raw FHIR bodies, patient references, clinical notes, PA answers, evidence text, and downstream exception strings are not written to server error logs. Metrics are aggregate counters and outbox state counts.

This project uses synthetic data, but the logging boundary is designed as if clinical identifiers were sensitive.
