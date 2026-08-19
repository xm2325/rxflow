# ADR 0039 — Dead-letter retirement uses an ordered gap marker

## Decision

When an ordered dead-letter head cannot safely be replayed, RxFlow does not mark it published. A privileged recovery transaction marks the original record `RETIRED`, stores actor/reason/reference audit metadata, and inserts `DeliveryGapDeclared` at the same aggregate sequence. The gap marker must publish before higher sequences become eligible.

## Why

A silent skip would falsify delivery history. Reusing the original event would also be wrong when replay is explicitly unsafe. A separate marker states what happened without copying clinical payload or operator identity to generic subscribers.

## Guardrail

`DeliveryGapDeclared` cannot itself be retired recursively.
