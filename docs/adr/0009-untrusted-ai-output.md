# ADR 0009: Treat raw AI output as untrusted input

## Decision

An external-model style adapter must parse raw text into the PA draft schema at runtime. Invalid JSON, wrong field types, unsupported evidence sources, or invalid confidence values fail closed before the workflow consumes the draft.

## Reason

Static TypeScript types do not validate text returned over a model API boundary. Schema correctness and evidence correctness are separate checks.

## Consequence

A valid schema still goes through evidence-grounding and human-review validation. A model field requesting `requiresHumanReview=false` does not bypass the workflow gate.
