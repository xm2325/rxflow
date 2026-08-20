# ADR 0041 — Two-person dead-letter retirement

## Context

An ordered dead-letter head may be unsafe to replay. v0.1.4 allowed a platform principal to retire it directly and insert a `DeliveryGapDeclared` marker. One credential therefore had full authority to perform a destructive recovery.

## Decision

Replace the HTTP direct-retirement operation with a durable retirement request followed by approval from a different platform principal. Bind the request to tenant, event ID and recovery generation. Approval atomically retires the original event, inserts the gap marker, marks the request approved and appends recovery audit.

## Consequences

A single compromised or mistaken platform principal cannot complete the recovery through the supported HTTP path. Redrive plus re-failure invalidates stale requests through the generation check. This is still an application-level reference control, not proof of an external organizational approval process.
