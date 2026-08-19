# ADR 0002: Idempotency is a progress guarantee, not only deduplication

A committed idempotency key cannot leave a request silently stuck after a dependency failure. RxFlow therefore persists explicit retryable or terminal failure state. Same-key, same-payload replay may resume only the failed stage. Concurrent replay while the first request is still running returns the existing case as in-progress and does not invoke the PA generator twice.
