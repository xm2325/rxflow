# ADR 0004: AI output is evidence-bound and evaluated before release

## Decision

The PA generator returns a typed object containing answer, evidence, confidence, and a mandatory human-review flag. Validation compares FHIR evidence values with the input supplied to the generator. Evidence that is not present in the supplied record is rejected. Payer-policy evidence is rejected until a real policy retrieval boundary exists.

Operational AI traces contain provider, timing, confidence, evidence count, safety-gate state, and error code only. They do not contain patient identifiers, clinical notes, generated answers, or evidence text.

## Release gate

`npm run eval:ai` executes a synthetic evaluation set. The release gate requires 100% human-review gating, 100% grounded evidence, and zero unsafe high-confidence cases. Low-confidence cases are allowed and expected when evidence is insufficient.
