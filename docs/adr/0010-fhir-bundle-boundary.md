# ADR 0010: Accept a constrained FHIR Bundle boundary

Status: accepted

RxFlow accepts either one MedicationRequest or a Bundle containing exactly one MedicationRequest plus optional Coverage resources. Coverage references may be resolved before request fingerprinting. Bundles with zero or multiple medication requests fail closed.

This is intentionally smaller than full FHIR R4 support. It gives the integration boundary a realistic multi-resource case without claiming general EHR interoperability.
