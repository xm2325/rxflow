# ADR 0011: Commit human review with compare-and-swap

Status: accepted

Application-level status checks are not sufficient after horizontal scaling because two workers can read `HUMAN_REVIEW_REQUIRED` concurrently. Review commits therefore condition the durable write on the stored status still being reviewable and insert approval/routing events in the same transaction.

A stale reviewer receives a conflict instead of producing duplicate review side effects.
